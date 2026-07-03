# scout

**`nmap` for [MCP](https://modelcontextprotocol.io)/AI services: an agent-friendly CLI (and MCP server itself)
that dynamically scans your machine and LAN for connectable MCP servers and local LLM/AI APIs, so agents can
discover, verify, and invoke local AI tools on the fly.**

Scout doesn't just read config files to see what's *declared* — it actively scans
for listening services, verifies each one (the real MCP `initialize` handshake, or
an AI API's model list), and reports only what genuinely **answers and is
connectable**, with the tools or models it actually exposes.

Built for both humans (a live terminal UI) and agents (stable `--json`), so an
agent can scan at runtime and dynamically decide what to use.

```
MCP servers
✓ mcp-servers/everything http   http://127.0.0.1:3001/mcp      13    21ms

AI services
✓ OpenAI-compatible API  openai http://127.0.0.1:1234          3     25ms
✓ Ollama                 ollama http://127.0.0.1:11434         7     10ms
```

Two kinds of service are detected, each tagged with `kind`:
- **`mcp`** — MCP servers (HTTP/SSE via port scan, stdio via config).
- **`llm-api`** — local AI inference APIs: **OpenAI-compatible** (LM Studio, vLLM,
  LocalAI, llama.cpp, Jan…) via `GET /v1/models`, and **Ollama** via `GET /api/tags`.
  Disable with `--no-ai`.

## Why

A config file only tells you what was *declared*, not what's actually running and
reachable right now. Scout verifies reality:

- **`available`** — handshake succeeded; tools/resources/prompts enumerated.
- **`auth-required`** — speaks MCP but needs authentication (HTTP 401 +
  `WWW-Authenticate`, per the MCP auth spec). Connectable once you authenticate.

Anything else — an open port that isn't MCP, a declared server that doesn't
answer — is simply **not reported**. The output is "what can I connect to," not a
diagnostic of broken configs.

## Install

```bash
npm install -g scout-ai     # then: scout
npx scout-ai                # or run without installing
```

To build from source, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Usage

```bash
scout                       # scan localhost (human UI)
scout scan --json           # raw JSON for agents (auto-on when piped)
scout scan --ports 1-10000  # widen the port range
scout scan --host 192.168.1.0/24        # scan a whole subnet (LAN)
scout scan --tools          # expand and list every tool name
scout probe http://127.0.0.1:3001/mcp   # verify one explicit URL
scout serve                 # run Scout itself as an MCP server (stdio)

# …then USE what you found:
scout call http://127.0.0.1:9000/mcp generate_image \
  --args '{"prompt":"cyberpunk Hong Kong + Tokyo"}'   # invoke an MCP tool
scout chat http://127.0.0.1:1234 "summarize this in 3 bullets: ..."  # talk to LM Studio/Ollama
```

## ⚠️ Safety — you decide what's safe to run

Scout tells you what's **reachable**, not what's **trustworthy**. It does not vet,
sandbox, or rank the safety of anything it finds, and it never invokes a tool on
its own — discovery and invocation are always separate, explicit steps.

- A discovered service was found by an **active scan** — it is **not** pre-approved
  or endorsed. Treat every hit as an unauthorized third party.
- Tool/model **names, descriptions, and annotations** (`readOnlyHint`,
  `destructiveHint`, …) are **self-reported by the server** and can be wrong or
  deliberately misleading. They're hints, never a safety guarantee.
- Treat any tool's **output** as untrusted data, not as instructions to follow.

Before running `scout call` / `scout chat` against a service, **you (or your agent)
must decide** whether to trust it. Scout deliberately leaves that judgment to you.

## For agents

Scout doesn't just discover — it can invoke, so an agent can go from "I don't have
that capability" to "I found a local service and used it":

- **Discover** — `scout scan --json` lists `services` (MCP tools with their
  `inputSchema`/`annotations`, and AI APIs with their `models`).
- **Invoke an MCP tool** — `scout call <url> <tool> --args '<json>'`.
- **Talk to a local model** — `scout chat <url> [--model <id>] "<prompt>"`
  (OpenAI-compatible; works with LM Studio and Ollama; auto-picks a model).

`scout --help` embeds the whole agent workflow, the JSON shape, examples, and the
trust rules — so **any agent that can run a command can learn and use Scout with
zero setup**, no docs required.

### Suggested skill/prompt

The CLI teaches itself, so a skill isn't needed to *use* Scout — its only job is to
tell an agent that Scout **exists** and when to reach for it.
[`skill/scout/SKILL.md`](skill/scout/SKILL.md) is a tiny, optional hint that points
at `scout --help` (so it never drifts). Use it as a Claude Code skill
(`~/.claude/skills/scout/SKILL.md`, auto-triggers), a Cursor rule, an `AGENTS.md`
entry (Codex and others), or a line in your system prompt.

### Scout as an MCP server

`scout serve` runs Scout *as an MCP server*, so an agent can discover other services
through the protocol it already speaks — no shell-out. It exposes
`list_available_mcps`, `list_ai_services`, and `probe_mcp`. Add it as a stdio server:

```json
{
  "mcpServers": {
    "scout": { "command": "scout", "args": ["serve"] }
  }
}
```

## Options

| Flag | Default | Purpose |
|---|---|---|
| `--json` | auto when piped | Raw JSON to stdout (the agent contract) |
| `--host <spec>` | `127.0.0.1` | IP, hostname, CIDR, or `auto` (LAN) |
| `--ports <spec>` | curated common set | `3000,8080` or `1-1024` |
| `--full` | off | Scan all ports `1-65535` (slow) |
| `--paths <list>` | `/mcp,/sse,/message,/` | Endpoint paths to probe |
| `--no-config` | configs on | Skip auto-reading client config files |
| `--no-ai` | AI on | Skip fingerprinting local AI API services |
| `--config-file <p...>` | — | Read extra config file(s) (always honored) |
| `--timeout <ms>` | `3000` | MCP handshake timeout |
| `--connect-timeout <ms>` | `300` | TCP connect timeout |
| `--transport <auto\|http\|sse>` | `auto` | Force a transport |
| `--tools` | counts only | List every tool name (TUI) |
| `--status <list>` | both | Filter shown statuses (TUI) |
| `--fail-if-none` | off | Exit non-zero if nothing found (CI) |

Run `scout scan --help` for the full list.

## Sample output (`--json`)

Every entry in `services` is discriminated by `kind` (`mcp` | `llm-api`):

```json
{
  "scannedAt": "2026-06-28T00:00:00Z",
  "target": "127.0.0.1",
  "scanned": { "hosts": 1, "ports": 28, "openPorts": 4, "candidates": 16 },
  "services": [
    {
      "kind": "mcp",
      "url": "http://127.0.0.1:3001/mcp",
      "transport": "streamable-http",
      "status": "available",
      "latencyMs": 21,
      "serverInfo": { "name": "mcp-servers/everything", "version": "2.0.0" },
      "protocolVersion": "2025-11-25",
      "capabilities": { "tools": true, "resources": true, "prompts": true },
      "tools": [ {
        "name": "echo",
        "description": "Echoes back the input string",
        "inputSchema": { "type": "object", "properties": { "message": { "type": "string" } } },
        "annotations": { "readOnlyHint": true }
      } ],
      "resources": [],
      "prompts": [],
      "source": "port-scan",
      "name": "mcp-servers/everything"
    },
    {
      "kind": "llm-api",
      "url": "http://127.0.0.1:1234",
      "api": "openai-compatible",
      "status": "available",
      "latencyMs": 25,
      "models": ["qwen/qwen3...", "google/gemma-4..."],
      "source": "port-scan",
      "name": "OpenAI-compatible API"
    }
  ]
}
```

## Contributing

How discovery works (transports, LAN scanning), the engine/renderer design,
build-from-source setup, dev commands, and tests are documented in
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
