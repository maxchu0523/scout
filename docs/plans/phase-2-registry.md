# Phase 2 — Persistent registry: `add` / `list` / `diff` / `watch`

Goal: Scout goes from point-in-time scanner to a source of truth for the AI
services on a machine/LAN — while leaving the `scout scan` contract untouched.
Depends on Phase 1 Task 1.2 (shared targeting flags).

**Invariant reminder (critical for this phase):** registry state ("last seen",
"unreachable", notes) appears only in the new commands. `scout scan --json`
output gains exactly one additive change in this phase: the new `"manual"`
value on the existing `source` field. Nothing else.

---

## Task 2.1 — Registry store module

### Storage design

- Directory: `~/.scout/`, overridable via the `SCOUT_HOME` environment
  variable (required for tests; resolve once per process).
- File: `<SCOUT_HOME>/registry.json`:

```jsonc
{
  "version": 1,
  "entries": [
    {
      "id": "mcp:127.0.0.1:9000",          // same scheme as originKey (see below)
      "kind": "mcp",                        // "mcp" | "llm-api"
      "name": "image-tools",
      "url": "http://127.0.0.1:9000/mcp",  // or the stdio command label
      "transport": "streamable-http",       // mcp only: "streamable-http" | "sse" | "stdio"
      "stdio": { "command": "npx", "args": ["-y", "some-mcp"] }, // stdio only
      "addedAt": "2026-07-05T10:00:00.000Z",
      "addedBy": "manual",                  // "manual" | "scan"
      "firstSeenAt": "2026-07-05T10:00:00.000Z",
      "lastSeenAt": "2026-07-05T10:00:00.000Z",
      "lastStatus": "available",            // "available" | "auth-required" | "unreachable"
      "notes": ""                            // optional free text
    }
  ]
}
```

### Implementation

- New files `src/registry/store.ts` and `src/registry/types.ts` (registry
  types stay out of `src/types.ts` — they are not part of the scan contract).
- Export: `loadRegistry(): Promise<Registry>` (missing file → empty registry;
  unparseable file → error naming the path, never silently overwrite),
  `saveRegistry(reg): Promise<void>` (mkdir -p; write `registry.json.tmp` then
  `rename` — atomic), and `originKeyForEntry(entry): string`.
- **Move `originKey` out of `scan.ts`** into a new `src/util/originKey.ts`
  operating on `{kind, url, transport?}` so scan, registry, and diff share one
  identity scheme (`mcp:stdio:<label>` for stdio; `<kind>:<url host>`
  otherwise). Re-import it in `scan.ts`; behavior identical.

### Tests (new `test/registry.test.ts`)

Point `SCOUT_HOME` at a `fs.mkdtemp` dir. Cover: load-missing → empty,
save→load round-trip, corrupted JSON → throws with path in message, tmp+rename
leaves no `.tmp` file behind.

### Out of scope

SQLite, multi-file history, file locking. One JSON file, versioned, is v1.

---

## Task 2.2 — `scout add` / `scout remove` / `scout list`

### CLI

```
scout add <url> [--name <n>] [--transport auto|http|sse] [--force] [--notes <text>]
scout add --stdio "<command and args>" --name <n> [--force] [--notes <text>]
scout remove <id-or-url-or-name>
scout list [--json] [--verify]
```

### Behavior

- **add**: verify first — build a `Candidate` and run `probeCandidate` (same
  call pattern as the `probe` command in [src/cli.ts](../../src/cli.ts); for
  `--stdio`, split the string into command/args like `scout call --command`
  does). On success, upsert an entry (`addedBy: "manual"`, `lastStatus` from
  the probe, timestamps now). On failure: exit 1 with a clear message unless
  `--force`, which stores it with `lastStatus: "unreachable"` and
  `lastSeenAt` omitted. Upsert key: `originKey` — re-adding updates
  name/notes rather than duplicating.
- **remove**: match by exact `id`, else exact `url`, else exact `name`; if a
  name matches multiple entries, list them and exit 2. Print what was removed.
- **list**: read the registry, no network by default. TTY output: one line per
  entry — status glyph (`✓` available / `🔒` auth-required / `✗` unreachable),
  name, kind, url/label, relative `lastSeenAt` ("2h ago"). `--json`: print
  `{ "version": 1, "entries": [...] }` verbatim. `--verify`: before printing,
  re-probe every entry (`probeCandidate` / `probeAiService` by kind, through
  `mapPool`, concurrency `DEFAULT_PROBE_CONCURRENCY`) and update
  `lastStatus`/`lastSeenAt` in the file.
- All three implementations live in `src/registry/commands.ts`, lazy-imported
  in the actions. Update `AGENT_GUIDE`.

### Tests (extend `test/registry.test.ts`)

Drive `addServer`/`removeServer`/`listEntries` functions directly (not via
child processes), with a real local MCP-ish HTTP fixture where needed:
add-verify-fail without `--force` rejects; `--force` stores unreachable;
upsert-not-duplicate; ambiguous remove throws.

### Out of scope

- Editing entries (`scout edit`) — re-`add` covers it.
- Importing whole client configs into the registry.

---

## Task 2.3 — Manual entries join the scan

### Type change

In [src/types.ts](../../src/types.ts): `export type Source = "port-scan" |
"config" | "manual";` and add `includeManual: boolean` to `ScanOptions`
(default true, CLI flag `--no-manual` added to `addTargetingOptions`).

### Implementation

- In `runScan` phase 2 (candidate building), when `opts.includeManual`, load
  the registry (lazy `await import("./registry/store.js")` so the store isn't
  on the hot path when disabled) and convert manual entries to `Candidate`s
  with `source: "manual"`: mcp entries → url/transport/stdio as stored;
  `llm-api` entries are handled by probing their URL's host:port with
  `probeAiService` (add them to the AI probe work list rather than the MCP
  candidate list).
- Dedup already collapses a manual entry that the port sweep also found
  (same `originKey`); verify `better()` still picks the available/faster one.
- **Scan writes back**: after assembling the result, if the registry file
  exists, update `lastSeenAt`/`lastStatus` for any entry whose `originKey`
  matches a scanned service, and set `lastStatus: "unreachable"` for manual
  entries that were probed this scan but produced no service. Registry absent →
  skip entirely. Failures to write are logged to stderr, never fatal.
- New flag `--record` (targeting group): additionally upsert **all** verified
  services from this scan into the registry with `addedBy: "scan"`.

### Tests

Scan-level test with `SCOUT_HOME` temp dir: manual entry for a live local
fixture appears in `ScanResult.services` with `source: "manual"`; dead manual
entry is absent from services but marked `unreachable` in the file; `--record`
persists a port-scan discovery.

### Out of scope

Any registry-derived field appearing in `ScanResult` beyond
`source: "manual"`.

---

## Task 2.4 — `scout diff`

### Design

Compare two `ScanResult`s keyed by `originKey`, classify into:

```ts
interface ScanDiff {
  added: Service[];
  removed: Service[];   // the OLD service object
  changed: { before: Service; after: Service; fields: string[] }[];
}
```

`changed` triggers: `status` differs; for `mcp`, the set of tool names
differs; for `llm-api`, the set of models differs. `fields` names what changed
(`"status"`, `"tools"`, `"models"`).

### CLI

```
scout diff [targeting flags] [--json]
scout diff --from <a.json> [--to <b.json>] [--json]
```

- Default mode: load `<SCOUT_HOME>/last-scan.json` as the baseline (exit 2
  with "no baseline — run `scout scan --record` or pass --from" if missing),
  run a live scan as the target, print the diff, then overwrite
  `last-scan.json` with the new result. `scout scan --record` (Task 2.3) also
  writes `last-scan.json`.
- `--from`/`--to`: compare two saved `scout scan --json` files; no network, no
  state writes.
- Output: `--json` → the `ScanDiff` object. TTY → `+ name (kind, url)` /
  `- name` / `~ name: status available→auth-required` lines, and exit code 0
  when the diff is empty, 3 when it is not (documented in help; lets scripts
  poll cheaply).

### Implementation

Pure function `diffScans(before, after): ScanDiff` in `src/registry/diff.ts`
plus the command wiring. Test the pure function exhaustively in
`test/diff.test.ts` (added/removed/status-change/tool-change/model-change/
no-change fixtures); one test for baseline-missing exit behavior.

---

## Task 2.5 — `scout watch`

### CLI

```
scout watch [targeting flags] [--interval <seconds>] [--json] [--record]
```

Default interval 60 (constant `DEFAULT_WATCH_INTERVAL_S` in
[src/defaults.ts](../../src/defaults.ts); minimum 5 — exit 2 below that).

### Behavior

- Loop forever until SIGINT: run `runScan`, diff against the previous
  iteration's result (in-memory; first iteration diffs against empty and
  reports everything as `added`), report, sleep, repeat. Use a plain
  `setTimeout` loop (`await new Promise(r => setTimeout(r, ms))`), not
  `setInterval`, so slow scans never overlap.
- Reporting: `--json` (or non-TTY) → one NDJSON line per event:
  `{"event":"added"|"removed"|"changed","at":"<iso>","service":{...}}` and a
  heartbeat `{"event":"scan","at":...,"services":N}` per sweep. TTY → the same
  as timestamped human lines. **No Ink** in v1 — plain stderr/stdout lines.
- `--record` updates the registry + `last-scan.json` each sweep (reusing Task
  2.3/2.4 write paths).
- Implementation in `src/registry/watch.ts`, lazy-imported. Update
  `AGENT_GUIDE` ("agents can consume `scout watch --json` as an NDJSON
  stream").

### Tests

Factor the loop so one iteration is a testable function
(`watchOnce(prev, opts) → { result, diff }`); test two iterations against a
fixture server that changes between calls (start server → iteration 1 → stop
server → iteration 2 reports `removed`). Do not test the infinite loop itself.

### Out of scope

- Ink/live-table UI for watch (Phase 3's web UI supersedes it).
- Webhooks/notifications on change (future).
- mDNS listening (separate future task; noted in Phase 3 doc).
