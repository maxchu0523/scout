import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  // Code-splitting keeps the Ink/React renderer in its own chunk so the
  // --json / non-TTY agent path never loads it (dynamic import in cli.ts).
  splitting: true,
  clean: true,
  sourcemap: false,
  minify: false,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Measure real bundle size; written to dist/metafile-*.json
  metafile: true,
});
