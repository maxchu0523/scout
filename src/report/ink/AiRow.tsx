import { Box, Text } from "ink";
import type { AiServiceResult } from "../../types.js";

function fit(s: string, w: number): string {
  if (s.length > w) return `${s.slice(0, Math.max(0, w - 1))}…`;
  return s.padEnd(w);
}

const STATUS = {
  available: { icon: "✓", color: "green" as const },
  "auth-required": { icon: "🔒", color: "yellow" as const },
};

const COLS = { name: 22, api: 8, target: 30, models: 13 };

const API_LABEL: Record<string, string> = {
  "openai-compatible": "openai",
  ollama: "ollama",
  comfyui: "comfyui",
};

function line(name: string, api: string, target: string, models: string) {
  return `${fit(name, COLS.name)} ${fit(api, COLS.api)} ${fit(
    target,
    COLS.target,
  )} ${fit(models, COLS.models)}`;
}

export function AiHeaderRow() {
  return (
    <Text bold color="gray">
      {"  "}
      {line("NAME", "API", "URL", "MODELS")} LATENCY
    </Text>
  );
}

export function AiRow({
  service,
  showModels,
}: {
  readonly service: AiServiceResult;
  readonly showModels: boolean;
}) {
  const s = STATUS[service.status];
  const latency =
    service.status === "auth-required" ? "—" : `${service.latencyMs}ms`;
  const loaded =
    service.modelInfo?.filter((m) => m.state === "loaded").length ?? 0;
  const models =
    service.status === "auth-required"
      ? "—"
      : `${service.models.length}${loaded > 0 ? ` (${loaded} loaded)` : ""}`;

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={s.color}>{s.icon} </Text>
        {line(
          service.name,
          API_LABEL[service.api] ?? service.api,
          service.url,
          models,
        )}{" "}
        <Text color="gray">{latency}</Text>
      </Text>
      {showModels && service.models.length > 0 && (
        <Box flexDirection="column" marginLeft={4} marginBottom={1}>
          {service.models.map((m) => (
            <Text key={m} color="gray">
              • <Text color="white">{m}</Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
