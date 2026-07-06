# Phase 1 — Service enrichment & `scout export`

Goal: make the data Scout already reports richer (without touching discovery
mechanics) and close the "found it → now use it" loop with `scout export`.
Five tasks, independent unless noted. Read
[README.md](README.md) invariants first.

**Fingerprinting philosophy** (context for Tasks 1.1 and 1.5): vendor-specific
endpoint patterns are acceptable — that is how scanners work (nmap's core
asset is literally a fingerprint database) — as long as every pattern is a
*question asked of the live service* and only the verified response is
reported. What is NOT acceptable is a catalog of assumed metadata reported
without verification. The pattern set stays small because local AI APIs
converge on a few protocol families (OpenAI-compatible, Ollama, ComfyUI), not
one API per product. Do not generalize this into a plugin system beyond the
ordered-array structure specified in Task 1.5.

---

## Task 1.1 — Rich model metadata for AI services

### Problem

`AiServiceResult.models` is only a list of id strings. Ollama and LM Studio can
self-describe much more (family, parameter size, quantization, context length,
loaded state), and LM Studio is currently reported under the generic name
"OpenAI-compatible API".

### Type changes ([src/types.ts](../../src/types.ts))

Add a new exported interface and one **optional** field. Do not change any
existing field.

```ts
/** Per-model detail, populated when the API self-describes it. */
export interface ModelInfo {
  id: string;
  /** Model family/architecture, e.g. "llama", "qwen2". */
  family?: string;
  /** e.g. "7.6B" — keep as the string the API returned. */
  parameterSize?: string;
  /** e.g. "Q4_K_M". */
  quantization?: string;
  contextLength?: number;
  /** LM Studio reports load state. */
  state?: "loaded" | "not-loaded";
  /** e.g. "llm" | "embeddings" | "vlm" (LM Studio). */
  type?: string;
}
```

On `AiServiceResult`, after `models`:

```ts
  /** Optional per-model detail (Ollama /api/show, LM Studio /api/v0/models). */
  modelInfo?: ModelInfo[];
```

`models: string[]` stays exactly as-is — agents depend on it.

### Implementation ([src/probe/aiProbe.ts](../../src/probe/aiProbe.ts))

All enrichment happens **inside `probeAiService`, after** the existing
fingerprint has already succeeded, and is strictly best-effort: any failure or
unexpected shape → omit `modelInfo` (or the affected entry), never fail the
probe, never delay it beyond the existing `opts.timeoutMs` per request.

1. **Ollama branch** (after `ollamaModels(tags.body)` returns a list):
   - For up to `DEFAULT_MODEL_DETAIL_LIMIT` models (new constant in
     [src/defaults.ts](../../src/defaults.ts), value `8`), POST
     `${base}/api/show` with JSON body `{"model": "<name>"}` and
     `content-type: application/json`, reusing the timeout/abort pattern of
     `getJson` (add a sibling `postJson` helper).
   - Map the response: `details.family` → `family`,
     `details.parameter_size` → `parameterSize`,
     `details.quantization_level` → `quantization`. For `contextLength`, scan
     the `model_info` object for the first key ending in `.context_length`
     with a numeric value.
   - Run the per-model requests through `mapPool` with concurrency 4.
2. **LM Studio detection** (in the OpenAI-compatible branch, after
   `openaiModels(v1.body)` succeeds):
   - GET `${base}/api/v0/models`. Valid shape: JSON object with a `data` array
     whose entries are objects with a string `id`. If the shape doesn't match,
     treat the service as plain OpenAI-compatible (unchanged behavior).
   - On match: set `name: "LM Studio"` on the result and map each entry:
     `arch` → `family`, `quantization` → `quantization`,
     `max_context_length` → `contextLength`, `state` → `state` (only accept
     the literal strings `"loaded"`/`"not-loaded"`), `type` → `type`.
   - This is one extra request, no per-model fan-out.
3. Thread `modelInfo` through `ollamaResult`/`openaiResult` as a new optional
   parameter; include the field only when non-empty.

### Rendering & help

- [src/report/ink/AiRow.tsx](../../src/report/ink/AiRow.tsx): if `modelInfo`
  has entries with `state === "loaded"`, show a `(N loaded)` suffix after the
  model count. Nothing else — keep the TUI change minimal.
- Update the `scan` command's `addHelpText` JSON sketch in
  [src/cli.ts](../../src/cli.ts) to mention `modelInfo` on `kind=llm-api`.

### Tests (extend `test/aiProbe.test.ts`)

Using the existing real-local-`http.createServer` pattern:

- Fake Ollama serving `/api/tags` + `/api/show` → result has
  `api: "ollama"` and `modelInfo[0]` with family/parameterSize/quantization/
  contextLength mapped correctly.
- Fake Ollama where `/api/show` returns 500 → probe still succeeds, `modelInfo`
  absent or missing that entry; `models` unaffected.
- Fake LM Studio serving `/v1/models` + `/api/v0/models` → `name` is
  `"LM Studio"`, `modelInfo` populated with `state`.
- Fake plain OpenAI-compatible where `/api/v0/models` 404s → `name` falls back
  to the existing behavior, no `modelInfo`.
- More models than `DEFAULT_MODEL_DETAIL_LIMIT` in `/api/tags` → `models` lists
  all, `modelInfo` has at most the limit.

### Out of scope

- Any change to `models: string[]`.
- Fingerprinting new API vendors — ComfyUI is Task 1.5; anything else
  (llama.cpp-native, vLLM-native) is future work.
- Showing full model detail tables in the TUI.

---

## Task 1.2 — Shared targeting flags (refactor; prerequisite for 1.3, 1.4, Phase 2)

### Problem

`scout export` (Task 1.4), `scout watch` and `scout diff` (Phase 2) all need
the scan targeting flags (`--host`, `--ports`, `--paths`, `--no-config`,
`--no-ai`, `--config-file`, `--connect-timeout`, `--timeout`, `--concurrency`,
`--transport`, `--full`). Duplicating `.option()` calls would drift.

### Implementation ([src/cli.ts](../../src/cli.ts))

- Extract the targeting/probe-behavior `.option()`/`.addOption()` calls of the
  `scan` command (NOT the output/display options: `--json`, `--quiet`,
  `--verbose`, `--no-color`, `--tools`, `--full-capabilities`, `--status`,
  `--sort`, `--fail-if-none`) into:

  ```ts
  function addTargetingOptions(cmd: Command): Command { ... }
  ```

- Extract the targeting subset of `CliScanOpts` into a `CliTargetingOpts`
  interface; `CliScanOpts` extends it. `buildScanOptions(o: CliTargetingOpts)`
  keeps its current logic, retyped.
- Rewire the `scan` command through the helper. **Behavior must be
  byte-identical**: same flags, same descriptions, same defaults, same help
  output.

### Tests

`npm run check` plus a manual diff of `npm run dev -- scan --help` output
before/after (paste both in the commit message).

### Out of scope

New flags or behavior changes of any kind.

---

## Task 1.3 — OpenAPI discovery behind `--openapi` (opt-in)

### Problem

For REST services that are neither MCP nor a known AI API, OpenAPI documents
are the standard self-description. We want them discoverable **without**
polluting the default contract, so this is a new opt-in targeting flag: with
`--openapi`, services exposing an OpenAPI document are reported as a new
service kind. Default scans are completely unaffected.

### Type changes ([src/types.ts](../../src/types.ts))

Additive union member:

```ts
/** One HTTP service that self-describes via an OpenAPI document. */
export interface OpenApiServiceResult {
  kind: "openapi";
  /** Base URL, e.g. http://192.168.1.20:8080 */
  url: string;
  /** Where the document was found, e.g. "/openapi.json". */
  specPath: string;
  status: Status; // "available" only in practice; keep the union for symmetry
  latencyMs: number;
  /** info.title from the document. */
  name: string;
  /** info.description, truncated to 500 chars. */
  description?: string;
  /** info.version. */
  version?: string;
  /** Count of path+method operations. */
  operationCount: number;
  /** Up to 20 operations: "GET /v1/things — summary". */
  operations: string[];
  source: Source;
}

export type Service = ServerResult | AiServiceResult | OpenApiServiceResult;
```

Add `includeOpenApi: boolean` to `ScanOptions`.

### Implementation

- New file `src/probe/openApiProbe.ts` exporting
  `probeOpenApi(host, port, opts): Promise<OpenApiServiceResult | null>`.
  - Try, in order, GET on: `/openapi.json`, `/swagger.json`,
    `/v3/api-docs`, `/api-docs`. First hit wins.
  - **Strict shape check** (honesty rule): body must be a JSON object with a
    string `openapi` or `swagger` field AND an `info` object with a string
    `title`. Anything else → `null`.
  - Build `operations` from the `paths` object: for each path, each key in
    `{get,put,post,delete,patch,head,options}` present, format
    `"GET /path — <summary>"` (summary optional). Cap the array at 20,
    `operationCount` is the uncapped total.
  - Reuse the TLS-port scheme logic and `getJson` timeout pattern from
    `aiProbe.ts` (extract `getJson` into a small shared module
    `src/probe/http.ts` used by both probes rather than duplicating it).
- [src/scan.ts](../../src/scan.ts): in phase 3, when `opts.includeOpenApi`,
  add a third `mapPool` over `openPairs` calling `probeOpenApi`, merged
  through the same `record()`/`originKey` dedup. In `originKey`, `openapi`
  results key as `openapi:<host>` via the existing URL branch (no change
  needed — verify with a test). **Dedup priority:** if the same origin already
  produced an `mcp` or `llm-api` result, that result must win; implement by
  keying openapi results with their own kind prefix (the existing code already
  does this since `kind` is part of the key — verify).
- [src/cli.ts](../../src/cli.ts): add `--openapi` to `addTargetingOptions`
  (default off) → `includeOpenApi` in `buildScanOptions`. Also add the flag to
  `scout serve`'s scan tool arguments and defaults if that tool exposes
  targeting options (check [src/server/serve.ts](../../src/server/serve.ts)
  and mirror however `includeAi` is handled there).
- TUI: render `kind: "openapi"` rows with name, operation count, and latency.
  Follow `AiRow.tsx` as the template (new `OpenApiRow.tsx`), and handle the
  new kind in `App.tsx` wherever services are switched on `kind`.
- Help: mention `kind: "openapi"` in the scan help JSON sketch **only in the
  `--openapi` flag description**, and add the flag to `AGENT_GUIDE` examples.

### Tests (new `test/openApiProbe.test.ts`)

- Fake server with a valid minimal OpenAPI doc at `/openapi.json` → result with
  correct name/version/operationCount/operations formatting.
- Server returning 200 JSON that is *not* OpenAPI (no `openapi`/`swagger` key)
  → `null`.
- Doc with >20 operations → `operations.length === 20`,
  `operationCount` correct.
- Scan-level test: with `includeOpenApi: false` (default), a fake OpenAPI
  server yields **zero** services.

### Out of scope

- Parsing `$ref`s, schemas, auth flows, or anything beyond `info` + `paths`.
- Reporting OpenAPI services by default (the flag stays opt-in).
- YAML OpenAPI documents (JSON only in v1).

---

## Task 1.4 — `scout export` (depends on 1.2)

### Problem

Today the journey is: scan → see server → hand-edit an MCP client config.
`scout export` emits ready-to-paste client config for the MCP servers a scan
finds.

### CLI

```
scout export [targeting flags from 1.2]
  --format <mcp-json|vscode>   output style (default: mcp-json)
  --from <file>                read a prior `scout scan --json` output instead of scanning
  --out <file>                 write to a file instead of stdout
  --include-auth-required      also include auth-required servers (default: available only)
```

### Implementation

- New file `src/invoke/export.ts` (lazy-imported in the command action)
  exporting `buildExportConfig(result: ScanResult, format, includeAuthRequired)`
  returning a plain object, plus the small fs/stdout writer.
- Selection: `services` where `kind === "mcp"`, status `available` (plus
  `auth-required` with the flag). `llm-api` and `openapi` services are skipped
  (MCP client configs can't express them).
- Mapping per server, keyed by a sanitized `name`
  (lowercase, spaces→`-`, strip chars outside `[a-z0-9_-]`; on collision
  append `-2`, `-3`, …):
  - `transport: "streamable-http"` → `{ "type": "http", "url": <url> }`
  - `transport: "sse"` → `{ "type": "sse", "url": <url> }`
  - `transport: "stdio"` → `{ "command": <cmd>, "args": [...] }` — split from
    the stdio `url` label (first token = command, rest = args). Omit `env`
    entirely (config-discovered env may contain secrets; never re-emit it).
- Format wrappers: `mcp-json` → `{ "mcpServers": { ... } }` (Claude
  Desktop/Code, Cursor, `.mcp.json`); `vscode` → `{ "servers": { ... } }`.
- `--from` reads and `JSON.parse`s the file and validates it has a `services`
  array (exit 2 with a clear message otherwise); without `--from`, run
  `runScan(buildScanOptions(o))` with a quiet stderr progress line.
- Output is always pretty-printed 2-space JSON ending in a newline.
- Update `AGENT_GUIDE` in `cli.ts`: add
  `scout export --from scan.json > .mcp.json` style example, and a line in the
  numbered flow ("3. Adopt — scout export writes client config").

### Tests (new `test/export.test.ts`)

Pure-function tests on `buildExportConfig` with hand-built `ScanResult`
fixtures:

- http/sse/stdio servers map to the right entry shapes; env is never present.
- auth-required excluded by default, included with the flag.
- llm-api services never appear.
- Name sanitization and collision suffixing.
- vscode wrapper shape.

### Out of scope

- Writing directly into a user's live client config file (merge semantics are
  a Phase 2+ decision; v1 only prints/writes a standalone file).
- Per-client format zoo beyond the two formats above.

---

## Task 1.5 — ComfyUI fingerprint (depends on 1.1)

Reference: https://docs.comfy.org/development/api-development/overview

### Problem

ComfyUI (default port **8188**) is the dominant local image/video generation
server and is invisible to Scout today: it speaks neither MCP nor an
OpenAI-compatible API. It exposes its own REST + WebSocket API with no auth by
default on localhost.

ComfyUI is the **third protocol family** (after OpenAI-compatible and Ollama),
which per our design rule is the trigger to restructure the prober from an
if-chain into an ordered fingerprint table — do that restructure as part of
this task, and no more than that.

### Type changes ([src/types.ts](../../src/types.ts))

Both additive:

```ts
export type AiApi = "openai-compatible" | "ollama" | "comfyui";
```

On `AiServiceResult`, after `server`:

```ts
  /** Service version when the API self-reports it (e.g. ComfyUI). */
  version?: string;
```

Note: `kind` stays `"llm-api"` for ComfyUI. The kind name is historical —
read it as "local AI inference API". Adding a new `Service` union member for
one vendor is not worth the schema churn; the `api` field is the
discriminator agents should use.

### Restructure ([src/probe/aiProbe.ts](../../src/probe/aiProbe.ts))

Replace the inline sequence in `probeAiService` with an ordered array:

```ts
type AiFingerprint = (
  base: string,
  opts: { timeoutMs: number },
  start: number,
) => Promise<AiServiceResult | null>;

/** Order matters: Ollama before openai-compatible (it serves both API
 *  surfaces); ComfyUI anywhere before the openai-compatible catch-all. */
const FINGERPRINTS: AiFingerprint[] = [
  fingerprintOllama,
  fingerprintComfyUi,
  fingerprintOpenAiCompatible,
];
```

`probeAiService` computes `base`/`start` as today, then loops the array and
returns the first non-null result. Each existing branch (including Task 1.1's
enrichment) moves into its fingerprint function unchanged. No behavior change
for ollama/openai — the existing `test/aiProbe.test.ts` suite must pass
untouched (except additions).

### ComfyUI fingerprint

1. GET `${base}/system_stats`. **Strict shape**: JSON object with a `system`
   object where `system.comfyui_version` is a string, OR (older builds
   without the version field) a `system` object AND a `devices` array both
   present. Anything else → `null` (fall through to the next fingerprint).
   A 401 that passes `isAiAuth` → `auth-required` result with empty models.
2. On match, GET `${base}/models/checkpoints`. If it returns a JSON array of
   strings, that is `models` (checkpoint filenames). On 404/error/non-array →
   `models: []` — still a valid ComfyUI result; the honesty rule applies to
   what we report, and an empty checkpoint list is what we verified.
3. Result fields: `api: "comfyui"`, `name: "ComfyUI"`,
   `version: system.comfyui_version` (omit when absent), `server` from the
   response header as usual, `status`/`latencyMs`/`source` as the other
   fingerprints.

### Port sweep

Add `8188, // ComfyUI` to `DEFAULT_PORTS` in
[src/util/pool.ts](../../src/util/pool.ts), keeping the list's existing
ordering style (it is roughly ascending with 3845/11434 appended — insert
8188 between 8081 and 8443).

### Rendering & help

- TUI: no new component — `AiRow` already renders name + model count. If
  Task 1.1 added a loaded-count suffix, ComfyUI simply never has one.
- Update the scan help JSON sketch in [src/cli.ts](../../src/cli.ts):
  `"api":"openai-compatible"|"ollama"|"comfyui"`, and the `AGENT_GUIDE`
  kind line (`kind "llm-api" → local AI API; api
  ("openai-compatible"|"ollama"|"comfyui")`). Note in the `chat` command help
  that `scout chat` supports openai-compatible/ollama only — for ComfyUI,
  agents drive the service directly (`POST /prompt` with a workflow JSON).

### Tests (extend `test/aiProbe.test.ts`)

- Fake ComfyUI serving `/system_stats` (with `comfyui_version`) +
  `/models/checkpoints` → `api: "comfyui"`, `name: "ComfyUI"`, `version`
  mapped, `models` = checkpoint list.
- `/system_stats` without `comfyui_version` but with `system` + `devices` →
  still matches, `version` absent.
- `/models/checkpoints` 404 → result still returned with `models: []`.
- A 200 JSON at `/system_stats` with the wrong shape (no `system` object) →
  falls through; if the same server also serves `/v1/models`, it is reported
  as openai-compatible (ordering/fall-through test).
- Existing ollama/openai tests pass unmodified after the restructure.

### Out of scope

- Invoking ComfyUI (`scout generate` or similar) — invocation of workflow
  engines is a separate product decision; Phase 1 is discovery/description
  only.
- WebSocket (`/ws`) probing, queue/history endpoints, `/object_info`
  (multi-MB response — never fetch it during a scan).
- Enumerating loras/vae/other model folders beyond checkpoints.
- Comfy Cloud (`cloud.comfy.org`) — Scout scans local/LAN services only.
