import { Box, Text } from "ink";
import type { ServerResult } from "../../types.js";

function fit(s: string, w: number): string {
  if (s.length > w) return `${s.slice(0, Math.max(0, w - 1))}…`;
  return s.padEnd(w);
}

const STATUS = {
  available: { icon: "✓", color: "green" as const },
  "auth-required": { icon: "🔒", color: "yellow" as const },
};

const TRANSPORT_LABEL: Record<string, string> = {
  "streamable-http": "http",
  sse: "sse",
  stdio: "stdio",
};

const COLS = { name: 22, transport: 6, target: 30, tools: 5 };

function line(name: string, transport: string, target: string, tools: string) {
  return `${fit(name, COLS.name)} ${fit(transport, COLS.transport)} ${fit(
    target,
    COLS.target,
  )} ${fit(tools, COLS.tools)}`;
}

export function HeaderRow() {
  return (
    <Text bold color="gray">
      {"  "}
      {line("NAME", "TRANS", "TARGET", "TOOLS")} LATENCY
    </Text>
  );
}

export function ServerRow({
  server,
  showTools,
}: {
  readonly server: ServerResult;
  readonly showTools: boolean;
}) {
  const s = STATUS[server.status];
  const latency =
    server.status === "auth-required" ? "—" : `${server.latencyMs}ms`;
  const tools =
    server.status === "auth-required" ? "—" : String(server.tools.length);
  const transport = TRANSPORT_LABEL[server.transport] ?? server.transport;

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={s.color}>{s.icon} </Text>
        {line(server.name, transport, server.url, tools)}{" "}
        <Text color="gray">{latency}</Text>
      </Text>
      {showTools && server.tools.length > 0 && (
        <Box flexDirection="column" marginLeft={4} marginBottom={1}>
          {server.tools.map((t) => (
            <Text key={t.name} color="gray">
              • <Text color="white">{t.name}</Text>
              {t.description ? ` — ${t.description.split("\n")[0]}` : ""}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
