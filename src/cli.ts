import { Command, Option } from "commander";
import { expandHosts } from "./discovery/hosts.js";
import { probeCandidate } from "./probe/mcpProbe.js";
import { printJson } from "./report/json.js";
import { runScan } from "./scan.js";
import type {
  ScanEvent,
  ScanOptions,
  ScanResult,
  Status,
  Transport,
} from "./types.js";
import { DEFAULT_PORTS, parsePorts } from "./util/pool.js";

const VERSION = "0.3.0";

const program = new Command();
program
  .name("scout")
  .description(
    "Live scanner for connectable MCP servers and local AI API services.",
  )
  .version(VERSION);

interface CliScanOpts {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean; // --no-color => false
  host: string;
  ports?: string;
  full?: boolean;
  paths: string;
  config?: boolean; // --no-config => false
  ai?: boolean; // --no-ai => false
  configFile?: string[];
  connectTimeout: string;
  timeout: string;
  concurrency?: string;
  transport: "auto" | "http" | "sse";
  tools?: boolean;
  fullCapabilities?: boolean;
  status: string;
  sort: "name" | "latency" | "tools";
  failIfNone?: boolean;
}

function buildScanOptions(o: CliScanOpts): ScanOptions {
  let ports: number[];
  if (o.full) {
    process.stderr.write(
      "scout: --full scans all 65535 ports; this can be slow.\n",
    );
    ports = Array.from({ length: 65535 }, (_, i) => i + 1);
  } else if (o.ports) {
    ports = parsePorts(o.ports);
  } else {
    ports = DEFAULT_PORTS;
  }

  const concurrency = o.concurrency ? Number(o.concurrency) : undefined;

  const hosts = expandHosts(o.host);
  if (hosts.length > 256) {
    process.stderr.write(
      `scout: scanning ${hosts.length} hosts × ${ports.length} ports — this may take a while.\n`,
    );
  }

  return {
    hosts,
    target: o.host,
    ports,
    paths: o.paths
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
    includeConfig: o.config !== false,
    includeAi: o.ai !== false,
    extraConfigPaths: o.configFile ?? [],
    connectTimeoutMs: Number(o.connectTimeout),
    timeoutMs: Number(o.timeout),
    portConcurrency: concurrency ?? 200,
    probeConcurrency: concurrency
      ? Math.max(1, Math.floor(concurrency / 10))
      : 20,
    transport: o.transport,
  };
}

function parseStatusFilter(spec: string): Status[] {
  const valid: Status[] = ["available", "auth-required"];
  const picked = spec
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Status => (valid as string[]).includes(s));
  return picked.length ? picked : valid;
}

function wantsJson(o: CliScanOpts): boolean {
  return Boolean(o.json) || !process.stdout.isTTY;
}

function isAscii(o: CliScanOpts): boolean {
  return o.color === false || Boolean(process.env.NO_COLOR);
}

program
  .command("scan", { isDefault: true })
  .description("Scan for connectable MCP servers and local AI API services")
  // Output
  .option("--json", "emit raw JSON (auto-on when stdout is not a TTY)")
  .option("-q, --quiet", "suppress live progress")
  .option("-v, --verbose", "debug logging to stderr")
  .option("--no-color", "disable color / unicode animation")
  // Targeting
  .option(
    "--host <spec>",
    "host(s): IP, hostname, CIDR (192.168.1.0/24), range (.10-20), or auto",
    "127.0.0.1",
  )
  .option("--ports <spec>", "ports, e.g. 3000,8080 or 1-1024")
  .option("--full", "scan all ports 1-65535 (slow)")
  .option("--paths <list>", "endpoint paths to probe", "/mcp,/sse,/message,/")
  .option("--no-config", "do not read client config files for candidates")
  .option(
    "--no-ai",
    "do not fingerprint local AI API services (LM Studio, Ollama…)",
  )
  .option("--config-file <path...>", "extra config file(s) to read")
  // Probe behavior
  .option("--connect-timeout <ms>", "TCP connect timeout", "300")
  .option("--timeout <ms>", "MCP handshake timeout", "3000")
  .option("--concurrency <n>", "max parallel work")
  .addOption(
    new Option("--transport <mode>", "force transport")
      .choices(["auto", "http", "sse"])
      .default("auto"),
  )
  // Display (rendering-only — ignored under --json)
  .option("--tools", "list every tool name in the TUI")
  .option("--full-capabilities", "alias of --tools")
  .option(
    "--status <list>",
    "statuses to show (TUI)",
    "available,auth-required",
  )
  .addOption(
    new Option("--sort <field>", "sort the TUI table")
      .choices(["name", "latency", "tools"])
      .default("name"),
  )
  .option("--fail-if-none", "exit non-zero if no servers found")
  .action(async (o: CliScanOpts) => {
    const opts = buildScanOptions(o);
    let result: ScanResult;

    if (wantsJson(o)) {
      const onEvent: ((e: ScanEvent) => void) | undefined = o.verbose
        ? (e) => process.stderr.write(`[scout] ${e.type}\n`)
        : undefined;
      result = await runScan(opts, onEvent);
      printJson(result);
    } else {
      // Lazy import: React/Ink are NOT loaded on the agent/--json path.
      const { renderTui } = await import("./report/ink/index.js");
      result = await renderTui(opts, {
        showTools: Boolean(o.tools || o.fullCapabilities),
        statusFilter: parseStatusFilter(o.status),
        sort: o.sort,
        ascii: isAscii(o),
      });
    }

    if (o.failIfNone && result.services.length === 0) process.exit(1);
  });

program
  .command("serve")
  .description(
    "Run Scout as an MCP server (stdio), exposing discovery as MCP tools",
  )
  .action(async () => {
    // Lazy import: the server SDK + zod load only when actually serving.
    const { serveMcp } = await import("./server/serve.js");
    await serveMcp();
  });

program
  .command("probe <url>")
  .description("Probe a single explicit URL (skips discovery)")
  .option("--json", "emit raw JSON")
  .addOption(
    new Option("--transport <mode>", "force transport")
      .choices(["auto", "http", "sse"])
      .default("auto"),
  )
  .option("--timeout <ms>", "MCP handshake timeout", "5000")
  .action(
    async (
      url: string,
      o: {
        json?: boolean;
        transport: "auto" | "http" | "sse";
        timeout: string;
      },
    ) => {
      const hint: Transport =
        o.transport === "sse" || url.endsWith("/sse")
          ? "sse"
          : "streamable-http";
      const server = await probeCandidate(
        { url, transport: hint, source: "port-scan" },
        { timeoutMs: Number(o.timeout), transport: o.transport },
      );

      if (o.json || !process.stdout.isTTY) {
        process.stdout.write(`${JSON.stringify(server, null, 2)}\n`);
      } else if (!server) {
        process.stderr.write(`✗ ${url} — not a reachable MCP server\n`);
      } else {
        const tag =
          server.status === "available"
            ? `✓ ${server.name} (${server.tools.length} tools, ${server.latencyMs}ms)`
            : `🔒 ${server.name} — auth required`;
        process.stdout.write(`${tag}\n`);
        if (server.status === "available") {
          for (const t of server.tools) process.stdout.write(`  • ${t.name}\n`);
        }
      }

      if (!server) process.exit(1);
    },
  );

program
  .command("call <url> <tool>")
  .description("Invoke a tool on an MCP server and print the result")
  .option("--args <json>", "tool arguments as a JSON object", "{}")
  .addOption(
    new Option("--transport <mode>", "force transport")
      .choices(["auto", "http", "sse"])
      .default("auto"),
  )
  .option(
    "--command <cmd>",
    "treat <url> as a label and spawn this stdio command",
  )
  .option("--json", "emit the raw CallToolResult")
  .option("--timeout <ms>", "connect + call timeout", "20000")
  .action(
    async (
      url: string,
      tool: string,
      o: {
        args: string;
        transport: "auto" | "http" | "sse";
        command?: string;
        json?: boolean;
        timeout: string;
      },
    ) => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(o.args);
      } catch {
        process.stderr.write(`scout: --args is not valid JSON\n`);
        process.exit(2);
      }
      const { callMcpTool } = await import("./invoke/call.js");
      const stdio = o.command
        ? {
            command: o.command.split(" ")[0],
            args: o.command.split(" ").slice(1),
          }
        : undefined;
      const result = await callMcpTool(
        { url, transport: o.transport, stdio },
        tool,
        args,
        Number(o.timeout),
      );
      // Invoke commands return a payload: print the text by default, the full
      // result only with --json (unlike scan/probe where non-TTY implies JSON).
      if (o.json) {
        process.stdout.write(`${JSON.stringify(result.raw, null, 2)}\n`);
      } else {
        process.stdout.write(`${result.text}\n`);
      }
      if (result.isError) process.exit(1);
    },
  );

program
  .command("chat <url> <prompt>")
  .description("Send a prompt to a local AI API (LM Studio, Ollama, …)")
  .option("--model <name>", "model id (default: first available)")
  .option("--json", "emit the raw chat completion response")
  .option("--timeout <ms>", "request timeout", "120000")
  .action(
    async (
      url: string,
      prompt: string,
      o: { model?: string; json?: boolean; timeout: string },
    ) => {
      const { chat } = await import("./invoke/chat.js");
      const result = await chat(url, prompt, {
        model: o.model,
        timeoutMs: Number(o.timeout),
      });
      // The assistant text is the payload: print it by default; --json for the
      // full completion object.
      if (o.json) {
        process.stdout.write(`${JSON.stringify(result.raw, null, 2)}\n`);
      } else {
        process.stdout.write(`${result.text}\n`);
      }
    },
  );

program.parseAsync().catch((err) => {
  process.stderr.write(`scout: ${(err as Error).message}\n`);
  process.exit(2);
});
