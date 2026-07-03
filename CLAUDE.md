# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Scout is

A CLI that actively scans for **connectable** local/LAN MCP servers and local AI
APIs (LM Studio, Ollama), verifies each with a real handshake, and both reports
and invokes them — "nmap for MCP." Published to npm as `scout-ai`; the binary is
`scout`. Built for two audiences: humans (a live Ink TUI) and agents (stable
`--json`).

## Commands

```bash
npm run dev -- <args>     # run from source via tsx, e.g. npm run dev -- scan --ports 3001
npm run build             # tsup → dist/ (ESM, code-split, lazy Ink chunk)
npm run typecheck         # tsc --noEmit
npm run lint              # Biome lint + format check
npm run lint:fix          # auto-fix
npm test                  # all tests (node:test via tsx)
npm run check             # lint + typecheck + test — the CI/publish gate
```

Run a single test file or a single test by name:

```bash
node --import tsx --test test/hosts.test.ts
node --import tsx --test --test-name-pattern "parsePorts" test/pool.test.ts
```

A `githooks/pre-commit` gate (activated by the `prepare` script on `npm install`)
lints staged files and runs the full test suite, blocking the commit on failure.

## Architecture — the one rule that governs everything

**There is a single scan engine, `runScan()` in [src/scan.ts](src/scan.ts), that
produces exactly one data shape: `ScanResult` (defined in [src/types.ts](src/types.ts)).**
`--json` prints that object verbatim — it *is* the agent contract. Targeting
options (`--host`, `--ports`, `--no-ai`, …) change *which* services are found;
they must **never** change the shape of the output. Display flags (`--tools`,
`--status`, `--sort`) only filter/sort/abbreviate for the human UI and are ignored
under `--json`. Keep this invariant when adding features.

`runScan` runs four phases and streams progress through an `onEvent(ScanEvent)`
callback so any renderer can show live results: (1) port sweep over every
`(host, port)` pair, (2) build `Candidate`s from open ports (endpoint paths) plus
config-declared servers, (3) probe candidates concurrently — MCP handshake and/or
AI fingerprint — deduping by origin, (4) assemble the canonical `ScanResult`.

### Two renderers, and why React is quarantined

- **Agent path** (`--json` or non-TTY): `cli.ts` calls `runScan` + `printJson`
  directly. React/Ink is **never loaded** on this path.
- **Human path** (TTY): `cli.ts` does a **dynamic `import()`** of
  [src/report/ink/](src/report/ink/) only here; the Ink `<App>` calls the *same*
  `runScan` and renders `ScanEvent`s into live tables.

This lazy-import boundary is deliberate (keeps agent cold-start fast). Preserve
it: never import the Ink/React modules from the top level of `cli.ts` or the
engine. `tsup` `splitting: true` relies on the dynamic import to emit Ink as a
separate chunk.

### Service kinds & verification

`Service` is a discriminated union on `kind`:
- **`mcp`** (`ServerResult`) — HTTP/SSE found by port scan; stdio found by reading
  client configs and spawning. Verified by a real MCP `initialize` handshake.
- **`llm-api`** (`AiServiceResult`) — OpenAI-compatible (`GET /v1/models`) or
  Ollama (`GET /api/tags`).

Only two statuses are ever emitted: `available` and `auth-required`. Everything
else (open-but-not-MCP, declared-but-dead) is discarded, not reported.
`auth-required` requires a **strict** signal — HTTP 401 *plus* a `WWW-Authenticate`
header (see `confirmAuthRequired` in [src/probe/mcpProbe.ts](src/probe/mcpProbe.ts)) —
so unrelated services that merely reject us (e.g. a bare 403) aren't misclassified.

### Shared defaults

[src/defaults.ts](src/defaults.ts) holds engine defaults used by **both** the CLI
flags and the `scout serve` tool arguments, so the two entry points can't drift.
Change defaults there, not inline.

## Entry points

- `scout scan` (default command) — the scanner; the whole flow above.
- `scout probe <url>` — verify one explicit URL, skipping discovery.
- `scout call <url> <tool>` / `scout chat <url> <prompt>` — *invoke* a discovered
  service ([src/invoke/](src/invoke/)). Note: unlike scan/probe (non-TTY ⇒ JSON),
  these print the text payload by default and need explicit `--json` for the raw object.
- `scout serve` — run Scout *as* an MCP server (stdio) exposing discovery as MCP
  tools ([src/server/serve.ts](src/server/serve.ts)); zod + the server SDK are
  lazy-imported here only.

CLI wiring is Commander in [src/cli.ts](src/cli.ts). The top-level `--help` embeds
a full agent guide on purpose (the CLI is meant to be self-teaching) — keep it in
sync when commands change.

## Conventions

- **ESM throughout**, `"type": "module"`. TypeScript source uses **`.js` import
  specifiers** (e.g. `import { runScan } from "./scan.js"`) even though the files
  are `.ts` — required for Node ESM resolution of the built output. Match this.
- **Biome** for lint + format (2-space indent, double quotes, 80-col). Run
  `npm run lint:fix` before committing.
- Concurrency is bounded via `mapPool` in [src/util/pool.ts](src/util/pool.ts) —
  reuse it rather than spawning unbounded promises.
