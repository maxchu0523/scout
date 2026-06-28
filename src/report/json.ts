import type { ScanResult } from "../types.js";

/** Print the canonical result verbatim. This is the agent contract. */
export function printJson(result: ScanResult): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
