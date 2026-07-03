# Contributing to Scout

## Setup (from source)

```bash
git clone https://github.com/maxchu0523/scout.git
cd scout
npm install     # also activates the pre-commit hook (see below)
npm run build   # tsup → dist/ (code-split, lazy Ink chunk)
npm link        # optional: makes `scout` available globally
```

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

## Linting & tests

- **Lint/format:** [Biome](https://biomejs.dev) (`biome.json`) — one fast tool for both.
- **Tests:** Node's built-in `node:test` run through `tsx`, covering the pure logic
  (port parsing, concurrency pool, endpoint building, config parsing) in `test/`.
- **Pre-commit gate:** `githooks/pre-commit` lints **only the staged files**
  (`biome check --staged`) and runs the test suite, blocking the commit on failure.
  It's activated automatically on `npm install` via the `prepare` script
  (`git config core.hooksPath githooks`) — no Husky/lint-staged dependency.

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
scout scan --host auto                  # this machine's local subnet(s)
```

Multi-host scans use CIDR notation (`192.168.1.0/24`) or `auto`. Every
(host, port) pair is swept in one saturated concurrency pool, then each open
endpoint gets the real MCP handshake. A CIDR block is capped (65 536 hosts) and
Scout prints a heads-up before scanning more than 256 hosts. stdio discovery is
inherently local, so it applies only when localhost is in range.

## Design

One scan **engine** (`src/scan.ts`) produces a single canonical result object
(`ScanResult` in `src/types.ts`). Two renderers consume it:

- **Agent path** (`--json` / non-TTY): prints the canonical object verbatim. The
  React/Ink UI is **lazy-imported**, so this path never loads it.
- **Human path** (TTY): a React **Ink** UI (`src/report/ink/`) with a live
  "Scouting" animation and results tables (MCP servers + AI services) that stream
  in as each is verified.

Presentation flags (`--tools`, `--status`, `--sort`) only affect the human UI;
`--json` is always the full canonical object. Targeting flags change *what* is
scanned, never the output schema — **keep it that way**.

### Cost of the Ink UI (measured)

| | Agent path (`--json`) | Human path (Ink) |
|---|---|---|
| Cold start | ~0.10 s | ~0.20 s (+~100 ms to load React/Ink) |
| Deps loaded | MCP SDK only | + ink (696K) + react (368K) + yoga (296K) ≈ 1.4 MB |
| Bundled output | `cli.js` 5 KB + shared 13 KB | + lazy `ink-*.js` chunk 7 KB |
| Scan speed | identical — network-I/O bound, not render |

Because the Ink renderer is lazy-loaded, agents using `--json` pay none of its cost.
