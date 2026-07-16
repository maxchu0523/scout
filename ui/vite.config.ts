import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Build into the published package's dist/ui so `scout ui` can serve it.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Types only — never a runtime import from the Node engine.
      "@scout/types": fileURLToPath(new URL("../src/types.ts", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
  },
  server: {
    // `vite dev` proxies API calls to a running `scout ui --no-open`.
    proxy: {
      "/api": "http://127.0.0.1:7777",
    },
  },
});
