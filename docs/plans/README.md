# Scout roadmap — implementation plans

This folder contains the technical plans for the three-phase roadmap. Each phase
is a separate document, written to be executed **one task at a time, in order**,
by an implementing agent. Read this README fully before starting any task.

| Phase | Document | Theme |
| --- | --- | --- |
| 1 | [phase-1-enrichment.md](phase-1-enrichment.md) | Richer service data + `scout export` (small, independent wins) |
| 2 | [phase-2-registry.md](phase-2-registry.md) | Persistent registry: `add` / `list` / `diff` / `watch` |
| 3 | [phase-3-ui-and-bridge.md](phase-3-ui-and-bridge.md) | `scout ui` web dashboard + `scout expose` stdio bridge |

Phases build on each other (Phase 2 depends on Phase 1's shared-flag refactor;
Phase 3 depends on Phase 2's registry), but tasks *within* a phase are mostly
independent and each ends in a shippable state.

## Invariants — read before writing any code

These rules override anything a task description seems to imply. If a task
appears to require breaking one, stop and ask the user instead of proceeding.

1. **One engine, one shape.** `runScan()` in [src/scan.ts](../../src/scan.ts) is
   the only scan engine and produces exactly one shape: `ScanResult`
   ([src/types.ts](../../src/types.ts)). `--json` prints it verbatim — it is the
   agent contract.
   - Schema changes must be **additive only**: new *optional* fields, or new
     values on existing string unions. Never rename, remove, or change the type
     of an existing field. Never make `models: string[]` anything other than a
     string array.
   - Targeting flags change *which* services are found. Display flags only
     affect the TUI and are ignored under `--json`. No flag may change the
     schema of the output.
2. **Two statuses only, in scan output.** `scan`/`probe` emit only `available`
   and `auth-required`. Unreachable/unverifiable candidates are discarded, never
   reported. The Phase 2 registry is allowed to remember "last seen /
   unreachable" state, but that state appears **only** in registry commands
   (`scout list`, `scout diff`), never in `scout scan` output.
3. **Lazy-import quarantine.** React/Ink must never be imported at the top
   level of `cli.ts` or any engine module — only via dynamic `import()` inside
   the TTY branch. The same pattern applies to every new heavy module in these
   plans (registry store, UI server, expose bridge): top-level `cli.ts` imports
   only Commander + engine modules; each command's implementation is loaded
   with `await import(...)` inside its `.action()`. `tsup` code-splitting
   depends on this.
4. **ESM specifiers.** All imports of local TypeScript files use `.js`
   extensions (`import { runScan } from "./scan.js"`), even though sources are
   `.ts`.
5. **Bounded concurrency.** Any fan-out of network work goes through `mapPool`
   in [src/util/pool.ts](../../src/util/pool.ts). Never spawn unbounded
   parallel promises.
6. **Shared defaults.** Any new tunable default lives in
   [src/defaults.ts](../../src/defaults.ts), used by both the CLI and
   `scout serve`, never inlined.
7. **Honesty rule.** Scout only reports what a real network response verified.
   Never infer, guess, or hard-code descriptions of services. A fingerprint
   must require a shape-specific signal (see `openaiModels()` /
   `ollamaModels()` in [src/probe/aiProbe.ts](../../src/probe/aiProbe.ts) for
   the standard: a 200 with the wrong JSON shape is a rejection, not a match).
8. **Self-teaching help.** The top-level `AGENT_GUIDE` string and each
   command's `.addHelpText("after", ...)` in
   [src/cli.ts](../../src/cli.ts) must be updated whenever a command or output
   field is added. This is part of the definition of done for every task.
9. **Style & gate.** Biome (2-space indent, double quotes, 80-col). Run
   `npm run lint:fix` before committing. Every task must end with
   `npm run check` (lint + typecheck + tests) passing. A pre-commit hook runs
   the full suite; do not bypass it.

## Testing conventions

- Framework: `node:test` via tsx. Files live in `test/*.test.ts`. Run one file
  with `node --import tsx --test test/<name>.test.ts`.
- Network probes are tested against **real local HTTP servers** started inside
  the test with `node:http` (`http.createServer(...).listen(0)` for an
  ephemeral port) — see `test/aiProbe.test.ts` for the pattern. Do not mock
  `fetch`.
- Anything that touches `~/.scout` must honor the `SCOUT_HOME` environment
  variable (introduced in Phase 2) so tests can point it at a temp directory.

## Working style expected from the implementing agent

- Do one numbered task at a time; finish (including tests, help text, and
  `npm run check`) before starting the next.
- Each task lists **Out of scope** items. Do not do them, even if they seem
  like obvious improvements — they are either scheduled later or deliberately
  rejected.
- If actual API responses (Ollama, LM Studio) differ from the shapes documented
  in a plan, trust the real response, keep the strict-shape validation
  approach, and note the difference in the commit message.
