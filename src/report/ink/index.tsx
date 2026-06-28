import { render } from "ink";
import type { ScanOptions, ScanResult } from "../../types.js";
import { App, type DisplayOptions } from "./App.js";

/**
 * Entry point for the human renderer. This module (and therefore React/Ink) is
 * dynamically imported by cli.ts ONLY on the interactive path, so the
 * --json / non-TTY agent path never loads it.
 */
export async function renderTui(
  opts: ScanOptions,
  display: DisplayOptions,
): Promise<ScanResult> {
  let result: ScanResult | undefined;
  const app = render(
    <App opts={opts} display={display} onDone={(r) => (result = r)} />,
  );
  await app.waitUntilExit();
  if (!result) throw new Error("scan did not complete");
  return result;
}

export type { DisplayOptions };
