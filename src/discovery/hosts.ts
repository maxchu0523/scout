import { networkInterfaces } from "node:os";

/** Hard cap so a fat CIDR (e.g. /8) can't expand into millions of probes. */
export const MAX_HOSTS = 65536;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(s: string): boolean {
  const m = IPV4.exec(s);
  return m ? m.slice(1).every((o) => Number(o) <= 255) : false;
}

function ipToInt(ip: string): number {
  const m = IPV4.exec(ip);
  if (!m) throw new Error(`invalid IPv4 address: ${ip}`);
  return (
    ((Number(m[1]) << 24) |
      (Number(m[2]) << 16) |
      (Number(m[3]) << 8) |
      Number(m[4])) >>>
    0
  );
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(
    ".",
  );
}

/** Number of leading 1-bits in a dotted netmask (e.g. 255.255.255.0 → 24). */
function maskToPrefix(mask: string): number {
  const bits = ipToInt(mask).toString(2).padStart(32, "0");
  return bits.indexOf("0") === -1 ? 32 : bits.indexOf("0");
}

function rangeToHosts(startInt: number, endInt: number): string[] {
  if (endInt < startInt) [startInt, endInt] = [endInt, startInt];
  const count = endInt - startInt + 1;
  if (count > MAX_HOSTS) {
    throw new Error(
      `host range too large (${count} hosts; max ${MAX_HOSTS}). Narrow it with a smaller range or prefix.`,
    );
  }
  const out: string[] = [];
  for (let n = startInt; n <= endInt; n++) out.push(intToIp(n));
  return out;
}

/** Expand an IPv4 CIDR (e.g. 192.168.1.0/24) into scannable host addresses. */
export function expandCidr(cidr: string): string[] {
  const [base, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  if (!isIpv4(base) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const baseInt = ipToInt(base);
  const hostBits = 32 - prefix;
  const network = hostBits === 32 ? 0 : (baseInt >>> hostBits) << hostBits;
  const broadcast = network + 2 ** hostBits - 1;

  // /31 and /32 have no separate network/broadcast addresses to skip.
  if (prefix >= 31) return rangeToHosts(network >>> 0, broadcast >>> 0);
  return rangeToHosts((network + 1) >>> 0, (broadcast - 1) >>> 0);
}

/** Detect the CIDR(s) of this machine's non-internal IPv4 interfaces. */
export function detectLocalCidrs(): string[] {
  const cidrs = new Set<string>();
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      const prefix = maskToPrefix(i.netmask);
      const hostBits = 32 - prefix;
      const network =
        hostBits === 32 ? 0 : (ipToInt(i.address) >>> hostBits) << hostBits;
      cidrs.add(`${intToIp(network >>> 0)}/${prefix}`);
    }
  }
  return [...cidrs];
}

/**
 * Resolve a `--host` spec into the concrete hosts to scan. Supports:
 *   - single IPv4 / IPv6 / hostname     → [spec]
 *   - CIDR                              192.168.1.0/24
 *   - explicit range                   192.168.1.10-192.168.1.20
 *   - last-octet shorthand range       192.168.1.10-20
 *   - "auto" / "lan"                   this machine's local subnet(s)
 */
export function expandHosts(spec: string): string[] {
  const s = spec.trim();

  if (s === "auto" || s === "lan") {
    const cidrs = detectLocalCidrs();
    if (cidrs.length === 0) {
      throw new Error("could not auto-detect a local subnet to scan");
    }
    const all = new Set<string>();
    for (const c of cidrs) for (const h of expandCidr(c)) all.add(h);
    return [...all];
  }

  if (s.includes("/")) return expandCidr(s);

  if (s.includes("-")) {
    const [start, endRaw] = s.split("-").map((x) => x.trim());
    if (!isIpv4(start)) throw new Error(`invalid range start: ${start}`);
    // Shorthand: 192.168.1.10-20 → end is just the final octet.
    const end = endRaw.includes(".")
      ? endRaw
      : `${start.split(".").slice(0, 3).join(".")}.${endRaw}`;
    if (!isIpv4(end)) throw new Error(`invalid range end: ${endRaw}`);
    return rangeToHosts(ipToInt(start), ipToInt(end));
  }

  return [s];
}
