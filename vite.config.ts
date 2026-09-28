import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Content-Security-Policy for the worker plugin runtime's own script — the
// dev-server half of src-tauri/src/plugin_worker.rs (read from the same file so
// the two can't drift). A worker takes its CSP from its script's response, so
// this is what stops a worker-runtime plugin's `import("https://…")` in
// `tauri dev`; release builds get it from `on_web_resource_request`.
const PLUGIN_WORKER_CSP = readFileSync(
  new URL("./src-tauri/plugin-worker-csp.txt", import.meta.url),
  "utf8",
).trim();

/** @returns {import("vite").Plugin} */
function pluginWorkerCsp() {
  return {
    name: "viboplr:plugin-worker-csp",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/src/pluginWorker/runtime.ts")) {
          res.setHeader("Content-Security-Policy", PLUGIN_WORKER_CSP);
        }
        next();
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), pluginWorkerCsp()],
  worker: {
    rollupOptions: {
      // plugin_worker.rs matches `/assets/plugin-worker-*.js` to attach the CSP.
      // The only worker in the app is the plugin runtime.
      output: {
        entryFileNames: "assets/plugin-worker-[hash].js",
        chunkFileNames: "assets/plugin-worker-chunk-[hash].js",
      },
    },
  },
  test: {
    exclude: ["tests/e2e/**", "node_modules/**", ".claude/**"],
    environment: "jsdom",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
