import { connectMcpClient } from "../probe/mcpProbe.js";

export interface CallResult {
  isError: boolean;
  /** Flattened text from the tool's content blocks. */
  text: string;
  /** The raw MCP CallToolResult. */
  raw: unknown;
}

/** Extract readable text from an MCP tool result's content blocks. */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      const block = c as { type?: string; text?: string };
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return `[${block.type ?? "content"}]`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Invoke a tool on an MCP server: connect, call, return the result.
 * The "hands" half of discover → learn → invoke.
 */
export async function callMcpTool(
  target: {
    url: string;
    transport: "auto" | "http" | "sse";
    stdio?: { command: string; args?: string[] };
  },
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<CallResult> {
  const client = await connectMcpClient(target, timeoutMs);
  try {
    const raw = (await client.callTool({
      name: tool,
      arguments: args,
    })) as { content?: unknown; isError?: boolean };
    return {
      isError: raw.isError === true,
      text: flattenContent(raw.content),
      raw,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
