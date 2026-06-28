# scout

**A live MCP scanner — `nmap` for [Model Context Protocol](https://modelcontextprotocol.io) servers.**

Scout doesn't just read config files to see what's *declared* — it actively
scans for listening servers, performs the real MCP `initialize` handshake against
each candidate, and reports only what genuinely **answers and is connectable**,
along with the tools/resources/prompts it actually exposes.

Built for both humans (a live terminal UI) and agents (stable `--json`), so an
agent can scan at runtime and dynamically decide which MCP servers to use.

```
✓ mcp-servers/everything http   http://127.0.0.1:3001/mcp      13    21ms
🔒 some-gated-server       http   http://127.0.0.1:9000/mcp      —     —     (auth required)
```

## Why

A config file only tells you what was *declared*, not what's actually running and
reachable right now. Scout verifies reality:

- **`available`** — handshake succeeded; tools/resources/prompts enumerated.
- **`auth-required`** — speaks MCP but needs authentication (HTTP 401 +
  `WWW-Authenticate`, per the MCP auth spec). Connectable once you authenticate.

Anything else — an open port that isn't MCP, a declared server that doesn't
answer — is simply **not reported**. The output is "what can I connect to," not a
diagnostic of broken configs.

## How discovery works

MCP has multiple transports, and they're discovered differently:

| Transport | Listens on a port? | How Scout finds it |
|---|---|---|
| **Streamable HTTP** / legacy HTTP+SSE | yes | **port scan** + endpoint probe + handshake |
| **stdio** (local subprocess) | no | read client **configs** for the command, then spawn + handshake |

So the port sweep is the hero feature for HTTP servers; stdio servers are found
via config files (Claude Desktop, Claude Code, Cursor, VS Code, …) and verified
by spawning them.

### LAN scanning

`--host` accepts more than a single address — Scout can sweep an entire subnet
for HTTP/SSE MCP servers:

```bash
scout scan --host 192.168.1.0/24       # a CIDR block
scout scan --host 192.168.1.10-50      # a range (last-octet shorthand)
scout scan --host 10.0.0.1-10.0.0.20   # an explicit range
scout scan --host auto                  # this machine's local subnet(s)
```

Every (host, port) pair is swept in one saturated concurrency pool, then each
open endpoint gets the real MCP handshake. Ranges are capped (65 536 hosts) and
Scout prints a heads-up before scanning more than 256 hosts. stdio discovery is
inherently local, so it applies only when localhost is in range.

## Install

```bash
npm install
npm run build
npm link        # optional: makes `scout` available globally
```

## Usage

```bash
scout                       # scan localhost (human UI)
scout scan --json           # raw JSON for agents (auto-on when piped)
scout scan --ports 1-10000  # widen the port range
scout scan --host 192.168.1.0/24        # scan a whole subnet (LAN)
scout scan --tools          # expand and list every tool name
scout probe http://127.0.0.1:3001/mcp   # verify one explicit URL
scout serve                 # run Scout itself as an MCP server (stdio)
```

### Use Scout as an MCP server (discovery for agents)

`scout serve` runs Scout *as an MCP server*, so an agent can discover other MCP
servers through the protocol it already speaks — no shell-out, no config parsing.
It exposes two tools:

- **`list_available_mcps`** — scan for connectable servers (args: `host`, `ports`,
  `includeConfig`, `timeoutMs`); returns the canonical result with each server's
  transport, status, and tools.
- **`probe_mcp`** — verify one explicit `url`.

Add it to a client like Claude Code / Claude Desktop / Cursor as a stdio server:

```json
{
  "mcpServers": {
    "scout": { "command": "scout", "args": ["serve"] }
  }
}
```

Then the agent can call `list_available_mcps` at runtime to find — and connect
to — whatever MCP servers are actually live.

### Key options

| Flag | Default | Purpose |
|---|---|---|
| `--json` | auto when piped | Raw JSON to stdout (the agent contract) |
| `--host <spec>` | `127.0.0.1` | IP, hostname, CIDR, range, or `auto` (LAN) |
| `--ports <spec>` | curated common set | `3000,8080` or `1-1024` |
| `--full` | off | Scan all ports `1-65535` (slow) |
| `--paths <list>` | `/mcp,/sse,/message,/` | Endpoint paths to probe |
| `--no-config` | configs on | Skip auto-reading client config files |
| `--config-file <p...>` | — | Read extra config file(s) (always honored) |
| `--timeout <ms>` | `3000` | MCP handshake timeout |
| `--connect-timeout <ms>` | `300` | TCP connect timeout |
| `--transport <auto\|http\|sse>` | `auto` | Force a transport |
| `--tools` | counts only | List every tool name (TUI) |
| `--status <list>` | both | Filter shown statuses (TUI) |
| `--fail-if-none` | off | Exit non-zero if nothing found (CI) |

Run `scout scan --help` for the full list.

## Design

One scan **engine** produces a single canonical result object. Two renderers
consume it:

- **Agent path** (`--json` / non-TTY): prints the canonical object verbatim. The
  React/Ink UI is **lazy-imported**, so this path never loads it.
- **Human path** (TTY): a React **Ink** UI with a live "Scouting" animation and a
  results table that streams in as servers are verified.

Presentation flags (`--tools`, `--status`, `--sort`) only affect the human UI;
`--json` is always the full canonical object.

### JSON shape

```json
{
  "scannedAt": "2026-06-28T00:00:00Z",
  "target": "127.0.0.1",
  "scanned": { "hosts": 1, "ports": 28, "openPorts": 4, "candidates": 16 },
  "servers": [
    {
      "url": "http://127.0.0.1:3001/mcp",
      "transport": "streamable-http",
      "status": "available",
      "latencyMs": 21,
      "serverInfo": { "name": "mcp-servers/everything", "version": "2.0.0" },
      "protocolVersion": "2025-11-25",
      "capabilities": { "tools": true, "resources": true, "prompts": true },
      "tools": [ { "name": "echo", "description": "Echoes back the input string" } ],
      "resources": [],
      "prompts": [],
      "source": "port-scan",
      "name": "mcp-servers/everything"
    }
  ]
}
```

### Cost of the Ink UI (measured)

| | Agent path (`--json`) | Human path (Ink) |
|---|---|---|
| Cold start | ~0.10 s | ~0.20 s (+~100 ms to load React/Ink) |
| Deps loaded | MCP SDK only | + ink (696K) + react (368K) + yoga (296K) ≈ 1.4 MB |
| Bundled output | `cli.js` 5 KB + shared 13 KB | + lazy `ink-*.js` chunk 7 KB |
| Scan speed | identical — network-I/O bound, not render |

Because the Ink renderer is lazy-loaded, agents using `--json` pay none of its cost.

## Development

```bash
npm run dev -- scan --ports 3001   # run from source via tsx
npm run typecheck
npm run build                      # tsup → dist/ (code-split, lazy Ink chunk)

npm run lint                       # Biome lint + format check
npm run lint:fix                   # auto-fix lint/format
npm test                           # node:test unit tests (via tsx)
npm run check                      # lint + typecheck + test (CI gate)
```

### Linting & tests

- **Lint/format:** [Biome](https://biomejs.dev) (`biome.json`) — one fast tool for both.
- **Tests:** Node's built-in `node:test` run through `tsx`, covering the pure logic
  (port parsing, concurrency pool, endpoint building, config parsing) in `test/`.
- **Pre-commit gate:** `githooks/pre-commit` lints **only the staged files**
  (`biome check --staged`) and runs the test suite, blocking the commit on failure.
  It's activated automatically on `npm install` via the `prepare` script
  (`git config core.hooksPath githooks`) — no Husky/lint-staged dependency.

## License

MIT
