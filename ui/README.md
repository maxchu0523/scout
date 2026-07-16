# Scout UI

The React dashboard served by `scout ui`. It is a **build-time artifact**: `vite
build` compiles it into `../dist/ui`, which the published package ships and the
lazily-imported HTTP server ([src/server/ui.ts](../src/server/ui.ts)) serves. No
React ever loads on the CLI hot path.

## Develop

```bash
npm ci                    # install UI deps (from this ui/ dir)
# In one terminal, run the API server:
node ../dist/cli.js ui --no-open      # or: npm --prefix .. run dev -- ui --no-open
# In another, the Vite dev server (proxies /api → :7777):
npm run dev
```

## Build

```bash
npm run build             # → ../dist/ui
```

The root `npm run build` runs this automatically **after** tsup (tsup's
`clean: true` wipes `dist/`, so the UI build must come second). Before a fresh
root build, this package's deps must be installed: `npm ci --prefix ui` (the
root `prepack` does this).

## Constraints

- Types come from `@scout/types` (alias → `../src/types.ts`). **Types only** —
  never a runtime import from `../src` (the engine is Node code).
- No UI kit, chart, or state library. One CSS file, dark theme.
