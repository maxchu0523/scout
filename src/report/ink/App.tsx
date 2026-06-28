import { Box, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import { runScan } from "../../scan.js";
import type {
  ScanOptions,
  ScanResult,
  ServerResult,
  Status,
} from "../../types.js";
import { Scouting } from "./Scouting.js";
import { HeaderRow, ServerRow } from "./ServerRow.js";

export interface DisplayOptions {
  showTools: boolean;
  statusFilter: Status[];
  sort: "name" | "latency" | "tools";
  ascii: boolean;
}

function applyDisplay(
  servers: ServerResult[],
  d: DisplayOptions,
): ServerResult[] {
  const filtered = servers.filter((s) => d.statusFilter.includes(s.status));
  const sorted = [...filtered].sort((a, b) => {
    if (d.sort === "latency") return a.latencyMs - b.latencyMs;
    if (d.sort === "tools") return b.tools.length - a.tools.length;
    return a.name.localeCompare(b.name);
  });
  return sorted;
}

export function App({
  opts,
  display,
  onDone,
}: {
  readonly opts: ScanOptions;
  readonly display: DisplayOptions;
  readonly onDone: (r: ScanResult) => void;
}) {
  const { exit } = useApp();
  const [caption, setCaption] = useState("starting…");
  const [live, setLive] = useState<ServerResult[]>([]);
  const [result, setResult] = useState<ScanResult | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scan runs once on mount; opts/display/onDone are fixed for the app's lifetime.
  useEffect(() => {
    let mounted = true;
    runScan(opts, (e) => {
      if (!mounted) return;
      switch (e.type) {
        case "phase":
          setCaption(e.message);
          break;
        case "port-open":
          setCaption(`:${e.port} open · ${e.openCount} listening`);
          break;
        case "candidate":
          setCaption(`${e.total} candidates`);
          break;
        case "verified":
          setLive((prev) => [...prev, e.server]);
          break;
        case "done":
          setResult(e.result);
          break;
      }
    })
      .then((r) => {
        if (!mounted) return;
        onDone(r);
        // Let the final frame paint, then unmount (last frame stays on screen).
        setTimeout(() => exit(), 30);
      })
      .catch((err) => {
        if (!mounted) return;
        setCaption(`error: ${(err as Error).message}`);
        setTimeout(() => exit(), 30);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const done = result !== null;
  const servers = applyDisplay(result ? result.servers : live, display);

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box>
        <Text bold color="green">
          scout
        </Text>
        <Text color="gray"> · live MCP scanner · host {opts.host}</Text>
      </Box>

      {!done && (
        <Box marginTop={1}>
          <Scouting caption={caption} ascii={display.ascii} />
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {servers.length > 0 ? (
          <>
            <HeaderRow />
            {servers.map((s) => (
              <ServerRow
                key={`${s.transport}:${s.url}`}
                server={s}
                showTools={display.showTools}
              />
            ))}
          </>
        ) : (
          done && <Text color="gray">No connectable MCP servers found.</Text>
        )}
      </Box>

      {done && result && (
        <Box marginTop={1}>
          <Text color="gray">
            {result.servers.length} server
            {result.servers.length === 1 ? "" : "s"} ·{" "}
            {result.scanned.openPorts}/{result.scanned.ports} ports open ·{" "}
            {result.scanned.candidates} candidates probed
          </Text>
        </Box>
      )}
    </Box>
  );
}
