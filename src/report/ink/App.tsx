import { Box, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import { runScan } from "../../scan.js";
import type {
  AiServiceResult,
  OpenApiServiceResult,
  ScanOptions,
  ScanResult,
  ServerResult,
  Service,
  Status,
} from "../../types.js";
import { AiHeaderRow, AiRow } from "./AiRow.js";
import { OpenApiHeaderRow, OpenApiRow } from "./OpenApiRow.js";
import { Scouting } from "./Scouting.js";
import { HeaderRow, ServerRow } from "./ServerRow.js";

export interface DisplayOptions {
  showTools: boolean;
  statusFilter: Status[];
  sort: "name" | "latency" | "tools";
  ascii: boolean;
}

function sortServices<T extends Service>(items: T[], d: DisplayOptions): T[] {
  const filtered = items.filter((s) => d.statusFilter.includes(s.status));
  return [...filtered].sort((a, b) => {
    if (d.sort === "latency") return a.latencyMs - b.latencyMs;
    return a.name.localeCompare(b.name);
  });
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
  const [live, setLive] = useState<Service[]>([]);
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
          setCaption(`${e.host}:${e.port} open · ${e.openCount} found`);
          break;
        case "candidate":
          setCaption(`${e.total} candidates`);
          break;
        case "verified":
          setLive((prev) => [...prev, e.service]);
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
  const all = result ? result.services : live;
  const mcp = sortServices(
    all.filter((s): s is ServerResult => s.kind === "mcp"),
    display,
  );
  const ai = sortServices(
    all.filter((s): s is AiServiceResult => s.kind === "llm-api"),
    display,
  );
  const openapi = sortServices(
    all.filter((s): s is OpenApiServiceResult => s.kind === "openapi"),
    display,
  );

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box>
        <Text bold color="green">
          scout
        </Text>
        <Text color="gray">
          {" "}
          · live service scanner · target {opts.target}
          {opts.hosts.length > 1 ? ` (${opts.hosts.length} hosts)` : ""}
        </Text>
      </Box>

      {!done && (
        <Box marginTop={1}>
          <Scouting caption={caption} ascii={display.ascii} />
        </Box>
      )}

      {mcp.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>MCP servers</Text>
          <HeaderRow />
          {mcp.map((s) => (
            <ServerRow
              key={`${s.transport}:${s.url}`}
              server={s}
              showTools={display.showTools}
            />
          ))}
        </Box>
      )}

      {ai.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>AI services</Text>
          <AiHeaderRow />
          {ai.map((s) => (
            <AiRow key={s.url} service={s} showModels={display.showTools} />
          ))}
        </Box>
      )}

      {openapi.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>HTTP APIs (OpenAPI)</Text>
          <OpenApiHeaderRow />
          {openapi.map((s) => (
            <OpenApiRow key={s.url} service={s} showOps={display.showTools} />
          ))}
        </Box>
      )}

      {done && mcp.length === 0 && ai.length === 0 && openapi.length === 0 && (
        <Box marginTop={1}>
          <Text color="gray">No connectable services found.</Text>
        </Box>
      )}

      {done && result && (
        <Box marginTop={1}>
          <Text color="gray">
            {mcp.length} MCP · {ai.length} AI ·{" "}
            {openapi.length > 0 ? `${openapi.length} API · ` : ""}
            {result.scanned.openPorts} open across {result.scanned.hosts} host
            {result.scanned.hosts === 1 ? "" : "s"}
          </Text>
        </Box>
      )}
    </Box>
  );
}
