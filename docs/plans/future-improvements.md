# Future improvements & tech debt

A living backlog for after Phases 1–3. Organized by theme. Each item notes
*why* it matters and a rough *first step*, so a future implementer (or a weaker
model) can pick one up without re-deriving the context. Nothing here is
scheduled — it is a menu, roughly ordered by value-per-effort within each
section.

The three phase plans ([phase-1](phase-1-enrichment.md),
[phase-2](phase-2-registry.md), [phase-3](phase-3-ui-and-bridge.md)) are all
shipped. Read the invariants in [README.md](README.md) before acting on
anything below — they still hold.

---

## Tech debt from Phase 3 (address before building on these areas)

1. **`scout expose` builds a fresh `Server` + transport per HTTP request.**
   This is the SDK's documented stateless pattern and is correct, but it means
   per-request setup cost and a new upstream-capabilities snapshot each time.
   - *Why it matters:* fine for low call volume; a hot bridge pays avoidable
     overhead, and there's no backpressure.
   - *First step:* benchmark; if it matters, switch to stateful sessions
     (`sessionIdGenerator: () => randomUUID()`) with a `Map<sessionId,
     transport>` and per-session cleanup, mirroring the SDK's stateful example.
2. **`expose` does not react to upstream `tools/list_changed`.** The proxy
   snapshots capabilities at startup. If the upstream adds/removes tools, the
   bridge is stale until restarted (documented as out-of-scope in Phase 3).
   - *First step:* subscribe to the upstream client's notifications and
     re-advertise; or forward the `list_changed` notification downstream.
3. **UI server's single global scan lock (409).** Only one scan runs at a time
   per server process. Correct for one user, but two browser tabs collide.
   - *First step:* key scans by a client-supplied id and stream each
     independently, or make the lock per-connection.
4. **Path-traversal test is weak.** `fetch("/../package.json")` is normalized by
   the client before it hits the server, so the test proves little. The actual
   guard (`path.resolve` + `startsWith`) is sound but untested against a raw
   request.
   - *First step:* add a test using `node:net` to send a literal
     `GET /../../package.json HTTP/1.1` and assert 400.
5. **`ui/` duplicates React version pins** (`react@^18.3.1` in both root and
   `ui/package.json`). They can drift.
   - *First step:* document the coupling in `ui/README.md` (partly done), or add
     a tiny check script that compares the two.
6. **SDK's low-level `Server` is marked `@deprecated`** ("advanced use cases
   only"). `expose` relies on it for transparent proxying.
   - *Why it matters:* a major SDK bump could remove it.
   - *First step:* pin the `@modelcontextprotocol/sdk` minor range; add a smoke
     test that fails loudly if `setRequestHandler` disappears.
7. **`--record` write-back happens inside `runScan`.** The engine now performs
   registry IO (lazy-imported, best-effort). This couples the pure engine to a
   side effect.
   - *Why it matters:* slightly muddies the "one engine, one shape" invariant.
   - *First step:* if it becomes a problem, hoist the write-back to the callers
     (CLI actions) and keep `runScan` pure again.

---

## Reliability

1. **Registry write concurrency.** `saveRegistry` is atomic (tmp+rename) but two
   concurrent writers (e.g. a `scout watch --record` loop and a manual
   `scout add`) can lose an update — last writer wins, no read-modify-write
   lock.
   - *First step:* a lockfile (`registry.json.lock`) or an in-process queue;
     document the single-writer assumption until then.
2. **`scout watch` has no backoff on repeated scan failure.** If every sweep
   throws, it loops at the interval forever, logging each time.
   - *First step:* exponential backoff on consecutive failures; exit after N.
3. **AI probe enrichment adds latency under a large `--host` sweep.** Ollama
   `/api/show` fan-out (concurrency 4) per service can add up across many hosts.
   - *First step:* make enrichment opt-out under wide scans, or lower the
     per-model limit when `hosts.length > 1`.
4. **No timeout on the UI server's SSE scan.** A pathological `runScan` (huge
   `--full` range via query param) holds the connection and the scan lock.
   - *First step:* cap query-param port ranges server-side; add an overall scan
     deadline.
5. **`expose` upstream-death handling is coarse.** If the stdio child dies, the
   next request fails; the bridge process itself keeps running.
   - *First step:* listen for the client transport's `onclose`, mark the bridge
     unhealthy (503), and optionally exit non-zero per the Phase 3 spec.

## Quality (tests & correctness)

1. **Coverage reporting.** There is no coverage gate. `node:test` supports
   `--experimental-test-coverage`.
   - *First step:* add `npm run test:coverage`; eyeball gaps (the probes and
     `scan.ts` dedup/merge logic are the highest-value targets).
2. **Property/fuzz tests for the fingerprint shape-guards.** The honesty rule
   lives or dies on strict shape checks (`openaiModels`, ComfyUI `system_stats`,
   OpenAPI `parseOpenApiDoc`). Random JSON should never produce a false match.
   - *First step:* a table-driven test feeding malformed bodies to each
     fingerprint, asserting `null`.
3. **A single integration test that drives the real `dist/cli.js`** end-to-end
   (scan → export → add → diff) against local fixtures, catching wiring bugs the
   unit tests miss (they exercised several this project — e.g. the AI-fallback
   in `add`, the `build:server` ordering).
   - *First step:* a `test/e2e.test.ts` spawning the built binary with a temp
     `SCOUT_HOME`.
4. **UI has no automated test.** Deliberate for v1. A single Playwright smoke
   test (load page, run a scan against a fixture, open the drawer) would guard
   the SSE contract from the browser side.

## Maintainability

1. **CI pipeline.** The repo has a `githooks/pre-commit` gate but no visible CI
   config. A push/PR should run `npm run check` (and a `ui/` build) on a clean
   checkout — the surest way to catch the `npm ci --prefix ui` / build-order
   assumptions.
   - *First step:* a GitHub Actions workflow: matrix on Node 18/20/22, run
     `npm ci`, `npm ci --prefix ui`, `npm run check`, `npm run build`.
2. **Release automation.** Version is bumped by hand (`package.json` +
   `src/version.ts` must agree).
   - *First step:* derive `VERSION` from `package.json` at build time, or a
     `release` script that bumps both + tags.
3. **The fingerprint table is the extension point for AI vendors.** Phase 1
   restructured `aiProbe.ts` into an ordered `FINGERPRINTS` array. When adding a
   fourth family (vLLM-native, llama.cpp-native), add a function there — do not
   grow if-chains elsewhere. (Documented in phase-1; repeated here as the
   canonical "how to add a vendor" pointer.)
4. **Recurring SonarLint noise** (`transport: "auto" | "http" | "sse"` union
   repeated in ~4 signatures). Not a Biome error, but worth a shared
   `type TransportMode` alias in `types.ts` for readability.
5. **`scoutHome()` / `SCOUT_HOME` is resolved per call.** Fine, but if an env
   change mid-process ever matters, centralize it. Low priority.

## Product / feature roadmap (Phase 4+ candidates)

1. **mDNS / Bonjour discovery + advertisement.** Listen for `_mcp._tcp` on the
   LAN for instant discovery (no sweep), and have `scout expose` advertise
   itself. Pairs naturally: the bridge announces, other Scouts hear it. This was
   flagged across all three phase docs as the highest-value discovery upgrade.
2. **The gateway / traffic-observability pivot** (deferred at the end of
   [phase-3](phase-3-ui-and-bridge.md)). `scout expose` is already a
   single-server proxy — the seed of a gateway agents point at, which would let
   the UI draw live invocation edges. Biggest bet in the backlog; needs its own
   product decision and security review, not an incremental feature.
3. **UI graph edges.** Once there is edge data (from a gateway, or from
   invocations routed through `scout call`), upgrade the host-grouped cards to a
   real graph. Explicitly out-of-scope for the Phase 3 UI.
4. **Auth token store for `expose`.** Persist issued bearer tokens so a bridge
   survives restarts with a stable token; add rotation.
5. **Richer OpenAPI reporting** (opt-in, per phase-1 out-of-scope): follow
   `$ref`s, surface auth schemes, support YAML documents.
6. **More AI vendors** via the fingerprint table: vLLM-native metrics, TGI,
   llama.cpp server specifics.
7. **`scout call` through the registry** — invoke a remembered service by name
   (`scout call fs <tool>`) instead of pasting a URL; closes the
   discover→remember→invoke loop entirely.
8. **SQLite registry** if the JSON file grows unwieldy or multi-writer
   contention (see Reliability #1) becomes real. Deliberately deferred in
   phase-2; the JSON store is the v1.
