import net from "node:net";
import { mapPool } from "../util/pool.js";

/**
 * TCP connect-scan a single port on `host`. Resolves true if a connection is
 * accepted within `timeoutMs` (port open), false otherwise (closed/filtered).
 */
export function isPortOpen(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

export interface HostPort {
  host: string;
  port: number;
}

/**
 * Sweep every (host, port) pair, returning the open ones. A single flat pool
 * across the whole matrix keeps concurrency saturated when scanning a LAN
 * range (many hosts) rather than draining one host at a time.
 */
export async function scanHostPorts(
  pairs: HostPort[],
  timeoutMs: number,
  concurrency: number,
  onOpen?: (hp: HostPort, openCount: number) => void,
): Promise<HostPort[]> {
  const open: HostPort[] = [];
  await mapPool(pairs, concurrency, async (hp) => {
    if (await isPortOpen(hp.host, hp.port, timeoutMs)) {
      open.push(hp);
      onOpen?.(hp, open.length);
    }
  });
  return open;
}
