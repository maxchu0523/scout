# Phase 3 — `scout ui` web dashboard & `scout expose` stdio bridge

Two large, independent tracks. Depends on Phase 2 (the UI shows registry and
watch data; `expose` registers into the registry).

Architecture decision (already made — do not revisit): the UI is **not** a
separate project. It is a React app living in `ui/` in this repo, built to
static files at package build time, served by a tiny lazily-imported local
HTTP server. Rationale: the UI is a third renderer of the same `ScanResult`
contract and must version in lockstep with the schema. See invariant 3 in
[README.md](README.md) — no React on the CLI hot path.

---

## Task 3.1 — HTTP API server (`scout ui`, backend half)

Build and ship the server before the React app; it is independently testable
and the API is the contract the frontend consumes.

### CLI

```
scout ui [--port <n>] [--host <addr>] [--no-open]
```

- `--port` default `0` semantics: try `7777` (constant `DEFAULT_UI_PORT` in
  [src/defaults.ts](../../src/defaults.ts)); if taken, fall back to an
  ephemeral port. Print the final URL to stderr.
- `--host` default `127.0.0.1`. If the user passes anything else, print a
  warning that the dashboard has no authentication and is being exposed
  beyond loopback.
- `--no-open`: skip auto-opening the browser. Auto-open = spawn
  `open <url>` (darwin) / `xdg-open` (linux) / `start` (win32), errors
  ignored.

### Implementation

- New file `src/server/ui.ts`, lazy-imported from the command action.
  Use `node:http` only — **no Express or other new runtime dependencies**.
- Endpoints (all JSON; all responses set
  `access-control-allow-origin: <origin of the ui itself only>` — in practice
  same-origin, so no CORS header needed; do NOT add `*`):
  - `GET /api/version` → `{ "version": VERSION }`.
  - `GET /api/registry` → the registry file content (Phase 2 store), or
    `{ "version": 1, "entries": [] }`.
  - `GET /api/scan?host=<spec>&ports=<spec>&openapi=0|1` → **SSE stream**
    (`content-type: text/event-stream`). Translate params through the same
    parsing used by `buildScanOptions` (factor the pure parts of
    `buildScanOptions` in [src/cli.ts](../../src/cli.ts) into
    `src/util/scanOptions.ts` so CLI and UI server share it — same rule as
    `defaults.ts`). Run `runScan` and forward every `ScanEvent` as
    `event: <e.type>` / `data: <JSON.stringify(e)>`, ending with the `done`
    event, then close. One scan may run at a time; a second request while one
    is running gets HTTP 409.
  - Anything under `/api/` unknown → 404 JSON. Everything else → static files
    (Task 3.2's build output): resolve the assets directory as
    `new URL("./ui/", import.meta.url)` (i.e. `dist/ui/` next to the built
    `cli.js`). Serve `index.html` for `/`, correct `content-type` for
    `.js/.css/.svg/.html`, and **reject any path containing `..`** after
    normalization. If the assets directory doesn't exist (dev via tsx before
    a build), respond 503 with a plain-text "run `npm run build` first, or use
    the Vite dev server in ui/ (see ui/README)".
- SSE keep-alive: write a `: ping` comment line every 15s while a scan is
  streaming.

### Tests (new `test/uiServer.test.ts`)

Start the server on an ephemeral port with `SCOUT_HOME` temp dir; use `fetch`:
`/api/version` shape; `/api/registry` empty shape; `/api/scan` against
loopback with a tiny port list streams `phase` events and terminates with
`done` whose payload parses as a `ScanResult`; path-traversal request
(`/../package.json`) → 4xx; concurrent second scan → 409.

### Out of scope

Auth, TLS, persistence of scan history server-side, WebSockets.

---

## Task 3.2 — React dashboard (`scout ui`, frontend half)

### Project setup

- New directory `ui/` with its own `package.json` (`"private": true`) — **not**
  an npm workspace; the root package stays a single publishable package.
  Dependencies: `react`, `react-dom`, dev: `vite`, `@vitejs/plugin-react`,
  `typescript`. Nothing else — no UI kit, no chart/graph library, no state
  library.
- `ui/vite.config.ts`: `build.outDir: "../dist/ui"`, `emptyOutDir: true`,
  and dev-server proxy of `/api` → `http://127.0.0.1:7777` (so `vite dev`
  works against a running `scout ui --no-open`).
- Root `package.json` script changes:
  `"build": "tsup && npm --prefix ui run build"` (tsup's `clean: true` wipes
  `dist/` first, so the UI build must run **after** tsup), and
  `"build:ui": "npm --prefix ui run build"`. `files: ["dist"]` already covers
  `dist/ui`. CI note: `prepack` already runs `npm run build`; `ui/` needs its
  deps installed — add `"preinstall"` nothing; instead document in
  `ui/README.md` that `npm ci --prefix ui` is required before a root build,
  and add it to the `prepack` script:
  `"prepack": "npm ci --prefix ui && npm run build"`.
- Type sharing: the UI imports types **directly** from
  `../src/types.ts` via a path alias (`vite.config.ts` alias
  `"@scout/types": "../src/types.ts"`). Types only — never runtime imports
  from `src/` (enforced by review; the engine is Node code).

### App spec (keep it to ~5 components)

Single page, no router. Layout top to bottom:

1. **Header** — product name, `version` from `/api/version`, scan controls:
   host spec input (default `127.0.0.1`), ports input (placeholder "default
   ports"), "Scan" button, and a live phase/status line driven by SSE events.
2. **Host map** — the core view. One card **per host**, in a responsive CSS
   grid (no graph library, no SVG edges in v1). Services grouped under their
   host, ordered: mcp, llm-api, openapi. Host of a service =
   `new URL(service.url).hostname`; stdio MCP servers group under a pseudo-host
   card labeled `local (stdio)`. Each service row: kind badge (`MCP` /
   `LLM` / `API`), name, status dot (green available / amber auth-required),
   latency, and a count chip (`N tools` / `N models` / `N ops`).
3. **Detail drawer** — clicking a service opens a panel: full URL, transport,
   `serverInfo`/`protocolVersion`, and the tools list (name + description +
   `destructiveHint`/`readOnlyHint` badges) or models list (with `modelInfo`
   detail when present — family, quantization, context length, loaded state).
4. **Registry strip** — entries from `/api/registry` not present in the last
   scan render as grey "last seen 2h ago" ghost cards on their host (this is
   the one place registry state is shown; it is visibly distinct from live
   results).

Behavior: on load, fetch registry and auto-start a default scan. During a
scan, `verified` SSE events add cards live; `done` replaces state with the
canonical result. Rescan button re-opens the SSE stream (handle 409 by
disabling the button while scanning). No polling.

Styling: one plain CSS file, dark theme, system font stack. No Tailwind.

### Tests

`ui/` gets no test harness in v1 (keep the surface small). The root
`test/uiServer.test.ts` plus a build smoke check — add to root `check` script:
nothing (CI time); instead `prepack` already exercises the UI build. Manually
verify: `npm run build && node dist/cli.js ui`, scan localhost, open drawer.

### Out of scope

Graph edges / animated traffic visualization (needs the gateway decision — see
end of this doc), historical charts, editing the registry from the UI,
multi-scan tabs, light theme.

---

## Task 3.3 — `scout expose` (stdio → HTTP bridge)

### Problem

Stdio MCP servers are processes, invisible to network scans. `scout expose`
runs one locally and re-publishes it as a streamable-HTTP MCP server, making
it a first-class citizen other machines' scans can find and other agents can
call.

### CLI

```
scout expose <name-or-registry-id>            # a stdio entry from the registry
scout expose --command "npx -y some-mcp"      # or an explicit command
  --port <n>          default 0 → ephemeral, printed
  --host <addr>       default 127.0.0.1; warn loudly when not loopback
  --no-auth           disable the bearer token (only allowed with loopback host; exit 2 otherwise)
  --name <n>          exposed server name (default: underlying server's name)
```

### Implementation (`src/server/expose.ts`, lazy-imported)

- **Upstream**: connect an MCP SDK `Client` over
  `StdioClientTransport` (the SDK is already a dependency; follow the
  connection pattern in [src/invoke/call.ts](../../src/invoke/call.ts)).
- **Downstream**: an SDK `Server` over `StreamableHTTPServerTransport` on
  `node:http` (mirror how [src/server/serve.ts](../../src/server/serve.ts)
  builds a server, but HTTP instead of stdio).
- **Proxying**: on startup, `listTools`/`listResources`/`listPrompts` from the
  upstream once and register matching handlers downstream that forward the
  call to the upstream client verbatim and return its result verbatim. Do not
  transform payloads. Advertise only the capabilities the upstream actually
  reported. (Dynamic tool-list-changed notifications: out of scope v1;
  document that a restart is needed if the upstream's tools change.)
- **Auth (on by default)**: generate a 32-byte random hex token
  (`node:crypto`), print once to stderr:
  `Bearer token: <token>` plus a ready-to-run
  `scout probe http://<host>:<port>/mcp` hint. Every HTTP request without
  `authorization: Bearer <token>` → 401 with
  `www-authenticate: Bearer realm="scout-expose"` — which is exactly the
  strict signal `confirmAuthRequired` in
  [src/probe/mcpProbe.ts](../../src/probe/mcpProbe.ts) accepts, so other
  Scouts correctly report the bridge as `auth-required` instead of missing it.
- **Lifecycle**: SIGINT/SIGTERM → close downstream, kill the upstream child,
  exit 0. If the upstream process dies → log and exit 1.
- On successful startup, upsert a registry entry for the exposed URL
  (`addedBy: "manual"`, notes: `exposed from <command>`), and remove... no —
  **do not** auto-remove on shutdown (the ghost "last seen" entry is
  desirable). Just update `lastStatus` on exit if the write succeeds.

### Tests (new `test/expose.test.ts`)

Use a trivial stdio MCP fixture (create `test/fixtures/echo-mcp.ts`: an SDK
stdio server with one `echo` tool; check `test/fixtures/` for an existing one
first). Start the bridge on an ephemeral loopback port with auth on:
unauthenticated `POST /mcp` → 401 + `www-authenticate`; authenticated MCP
initialize + `tools/list` shows `echo`; `tools/call echo` round-trips;
upstream child killed → bridge process exits nonzero.

### Out of scope

- TLS, token rotation, multiple upstreams per bridge, auto-restart of a
  crashed upstream.
- mDNS advertisement of the bridge (`_mcp._tcp`) — worth a future task pairing
  with an mDNS *listener* in the scanner; do not start it here.

---

## Explicitly deferred: gateway / traffic observability

"Show agent ↔ service interactions live on the map" requires Scout to sit in
the traffic path (a proxy/gateway agents point at), which is a separate
product decision with its own security surface. Nothing in Phase 3 may
implement traffic capture. The prepared hooks are: `scout expose` (already a
proxy for one server — the natural seed of a gateway) and the UI's SSE event
model (a gateway would emit `invocation` events on the same channel). Revisit
after Phase 3 ships and there is user signal.
