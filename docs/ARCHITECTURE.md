# Scout — Architecture

One scan engine, one output contract: every discovery path in Scout funnels
through `runScan()` in [`src/scan.ts`](../src/scan.ts), which emits a stream of
`ScanEvent`s and returns exactly one shape — `ScanResult`
([`src/types.ts`](../src/types.ts)). `--json` prints that object verbatim (the
agent contract); the Ink TUI, the web dashboard, and `scout serve` are just
different renderers of the same engine.

The architecture is split into focused views below. In every diagram,
**solid arrows** are in-process calls / data flow and **dotted arrows** are I/O
crossing a boundary (network requests, file reads/writes, spawned processes).

---

## 1. The big picture

Everything flows through one engine. Commands and servers on top, the engine in
the middle, renderers and outputs at the bottom.

```mermaid
flowchart TB
  entry["Entry points<br/>scan · probe · call · chat · export<br/>diff · watch · serve · expose · ui"]
  engine["runScan() · src/scan.ts<br/>the single scan engine"]
  events["ScanEvent stream<br/>phase · port-open · candidate · verified · done"]
  result["ScanResult · src/types.ts<br/>the ONE output shape = agent contract"]
  live["Live renderers<br/>Ink TUI · web dashboard SSE"]
  final["Final outputs<br/>--json stdout · MCP tool JSON<br/>export config · diff/watch events"]

  entry --> engine
  engine -- "streams" --> events
  engine -- "returns" --> result
  events --> live
  result --> final
```

Targeting flags change *which* services are found; display flags only affect
the human UI. Neither may ever change the shape of `ScanResult`.

---

## 2. `scout scan` — the discovery pipeline

The default command. Five phases, streaming `ScanEvent`s throughout. Only
`available` and `auth-required` services are ever emitted — everything else
(open-but-not-MCP, declared-but-dead) is discarded.

```mermaid
flowchart TB
  scanC["scout scan (default)"]
  scanC -- "ScanOptions" --> p1

  p1["① Port sweep<br/>TCP connect · host × port · mapPool"]
  lan(("LAN"))
  p1 -. "connect" .-> lan

  p1 --> p2["② Build Candidates<br/>open ports × probe paths"]
  cfgs["MCP client configs<br/>Claude · Cursor · Windsurf · VS Code"]
  regJ[("~/.scout/registry.json")]
  cfgs -. "discoverFromConfig" .-> p2
  regJ -. "manual entries" .-> p2

  p2 --> p3["③ Probe concurrently"]
  p3 --> mcpP["mcpProbe → MCP servers<br/>real initialize handshake<br/>streamable-http / sse / stdio"]
  p3 --> aiP["aiProbe → LM Studio · Ollama · ComfyUI<br/>GET /api/tags · /v1/models"]
  p3 --> oaP["openApiProbe · opt-in<br/>GET /openapi.json …"]

  mcpP --> p4
  aiP --> p4
  oaP --> p4
  p4["④ Dedupe by originKey<br/>assemble ScanResult"]

  p4 --> p5["⑤ syncScanToRegistry · best-effort"]
  p5 -. "refresh lastSeen · --record upserts" .-> regJ

  p4 --> branch{"--json or non-TTY?"}
  branch -- "yes" --> json["printJson<br/>ScanResult verbatim = agent contract"]
  branch -- "no" --> ink["Ink TUI · React, lazy import<br/>live tables from ScanEvents"]
```

Verification rules: an MCP service must complete a real `initialize`
handshake; `auth-required` needs the strict signal HTTP 401 **plus** a
`WWW-Authenticate` header. On an `originKey` collision the better result wins
(available beats auth-required, then lower latency), and an `openapi` result is
dropped when an MCP/AI service already claimed the same host.

---

## 3. Registry, diff & watch

Persistent memory lives in `~/.scout/` (override with `$SCOUT_HOME`). Manual
registry entries feed back into every scan as candidates; `diff` and `watch`
compare scans keyed by `originKey`.

```mermaid
flowchart TB
  regC["scout add / remove / list"]
  regJ[("~/.scout/registry.json<br/>known mcp + llm-api services<br/>atomic writes · upsertEntry")]
  regC <--> regJ

  regJ -. "manual candidates" .-> engine["runScan()"]
  engine -. "refresh lastSeen · --record upserts" .-> regJ
  engine --> result["ScanResult"]

  lastJ[("~/.scout/last-scan.json<br/>baseline")]
  lastJ -. "before" .-> diffFn
  result -- "after" --> diffFn["diffScans → ScanDiff<br/>added · removed · changed<br/>status / tools / models / operations"]

  diffFn --> diffC["scout diff<br/>exit 3 on change · refreshes baseline"]
  diffFn --> watchC["scout watch<br/>WatchEvent NDJSON · setTimeout loop"]
  watchC -. "rescan every interval" .-> engine
```

---

## 4. `scout serve` — Scout *as* an MCP server

Runs over stdio so any MCP client can use discovery as tools. Read-only:
`record` is forced off so a discovery call never mutates the registry.

```mermaid
flowchart TB
  agent["MCP client<br/>Claude Code · any agent"]
  agent <-- "MCP over stdio" --> serveS["scout serve<br/>src/server/serve.ts · McpServer"]

  serveS --> t1["list_available_mcps"]
  serveS --> t2["list_ai_services"]
  serveS --> t3["probe_mcp"]

  t1 -- "filter kind=mcp" --> engine["runScan() · record:false"]
  t2 -- "filter kind=llm-api" --> engine
  t3 --> probe["probeCandidate()"]
```

---

## 5. `scout ui` — the web dashboard

A `node:http` server on `127.0.0.1:7777` serving the built React app plus a
live scan over Server-Sent Events. No React runtime is loaded on the CLI's
agent path — the dashboard is its own bundle in `dist/ui/`.

```mermaid
flowchart TB
  browser["Browser · React dashboard"]
  uiS["scout ui · src/server/ui.ts<br/>node:http @ 127.0.0.1:7777"]
  browser <--> uiS

  uiS --> scanEP["GET /api/scan<br/>Server-Sent Events"]
  uiS --> regEP["GET /api/registry"]
  uiS --> staticEP["GET /*<br/>static React app · dist/ui/"]

  scanEP -- "resolveScanOptions" --> engine["runScan()"]
  engine -- "ScanEvent → SSE frames" --> scanEP
  regEP -. "loadRegistry" .-> regJ[("~/.scout/registry.json")]
```

---

## 6. `scout expose` — stdio → HTTP bridge

Publishes a local stdio-only MCP server onto the network. Guarded by a bearer
token whose `401 + WWW-Authenticate` response is exactly the strict signal
another Scout reads as `auth-required` — so remote scouts discover it cleanly.

```mermaid
flowchart TB
  child["Local stdio MCP server<br/>spawned child process"]
  expS["scout expose · src/server/expose.ts<br/>connectMcpClient → proxy Server"]
  child <-. "stdio · spawns child" .-> expS

  expS --> ep["POST /mcp<br/>StreamableHTTP · bearer token"]
  remote["Remote agent · another Scout"]
  remote <-. "HTTP + Authorization: Bearer" .-> ep

  expS -. "upsert exposed URL" .-> regJ[("~/.scout/registry.json")]
```

---

## 7. One-shot commands — probe & invoke

Beyond scanning, Scout verifies and *invokes* individual services. These skip
discovery and act on one explicit URL.

```mermaid
flowchart TB
  probeC["scout probe url"] --> probeFn["probeCandidate()<br/>one MCP handshake"]
  probeFn -. "initialize" .-> mcp1["MCP server"]

  callC["scout call url tool"] --> callFn["connectMcpClient → callTool"]
  callFn -. "tools/call" .-> mcp2["MCP server"]

  chatC["scout chat url prompt"] --> chatFn["POST /v1/chat/completions"]
  chatFn -. "chat" .-> llm["LM Studio · Ollama"]

  exportC["scout export"] --> exportFn["buildExportConfig<br/>ScanResult → client config"]
  exportFn --> cfg["mcp-json {mcpServers}<br/>vscode {servers}<br/>env never re-emitted"]
```

---

## Shared seams

A few modules exist specifically to keep the entry points from drifting:

- **[`src/defaults.ts`](../src/defaults.ts)** — engine defaults shared by the
  CLI flags and the `serve` tool arguments.
- **[`src/util/scanOptions.ts`](../src/util/scanOptions.ts)** —
  `resolveScanOptions()`, the one place raw inputs become a full `ScanOptions`;
  used by both the CLI and the UI server.
- **[`src/util/originKey.ts`](../src/util/originKey.ts)** — the single service
  identity scheme (`mcp:stdio:<label>` or `<kind>:<host:port>`) used by scan
  dedupe, the registry, and diffing.
- **[`src/probe/mcpProbe.ts`](../src/probe/mcpProbe.ts)** `connectMcpClient()` —
  shared by probing, `call`, and `expose`.
