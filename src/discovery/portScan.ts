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

/**
 * Sweep `ports` on `host`, returning the open ones. Calls `onOpen` as each is
 * found so the UI can stream progress.
 */
export async function scanPorts(
  host: string,
  ports: number[],
  timeoutMs: number,
  concurrency: number,
  onOpen?: (port: number, openCount: number) => void,
): Promise<number[]> {
  const open: number[] = [];
  await mapPool(ports, concurrency, async (port) => {
    if (await isPortOpen(host, port, timeoutMs)) {
      open.push(port);
      onOpen?.(port, open.length);
    }
  });
  return open.sort((a, b) => a - b);
}
