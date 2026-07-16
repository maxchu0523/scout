import { Box, Text } from "ink";
import type { OpenApiServiceResult } from "../../types.js";

function fit(s: string, w: number): string {
  if (s.length > w) return `${s.slice(0, Math.max(0, w - 1))}…`;
  return s.padEnd(w);
}

const COLS = { name: 22, version: 8, target: 30, ops: 6 };

function line(name: string, version: string, target: string, ops: string) {
  return `${fit(name, COLS.name)} ${fit(version, COLS.version)} ${fit(
    target,
    COLS.target,
  )} ${fit(ops, COLS.ops)}`;
}

export function OpenApiHeaderRow() {
  return (
    <Text bold color="gray">
      {"  "}
      {line("NAME", "VERSION", "URL", "OPS")} LATENCY
    </Text>
  );
}

export function OpenApiRow({
  service,
  showOps,
}: {
  readonly service: OpenApiServiceResult;
  readonly showOps: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">◇ </Text>
        {line(
          service.name,
          service.version ?? "—",
          service.url,
          String(service.operationCount),
        )}{" "}
        <Text color="gray">{service.latencyMs}ms</Text>
      </Text>
      {showOps && service.operations.length > 0 && (
        <Box flexDirection="column" marginLeft={4} marginBottom={1}>
          {service.operations.map((op) => (
            <Text key={op} color="gray">
              • <Text color="white">{op}</Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
