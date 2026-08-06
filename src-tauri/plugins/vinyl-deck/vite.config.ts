import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * Bundles the plugin to the single file the host already knows how to load.
 *
 * The host runs plugin code as `new Function("api", code)` and uses whatever the
 * body RETURNS as the module. So this emits an IIFE assigned to a local, plus a
 * footer that returns it — the loader is untouched, and the build step is purely
 * author-side. That is what makes adopting a toolchain cheap: no CSP work, no
 * module resolution inside the webview, and no migration for plugins that stay
 * hand-written.
 *
 * Output lands at the plugin root as `index.js`, which is both what the host
 * reads and what `tauri.conf.json` bundles (it ships `plugins/` wholesale).
 */
export default defineConfig({
  build: {
    // Vite refuses to emit into its own root, so emit to dist/ and let
    // scripts/build-plugins.mjs move the single artifact into place.
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    minify: false, // a readable bundle is worth more than the bytes here
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["iife"],
      name: "__viboplrPlugin",
      fileName: () => "index.js",
    },
    rollupOptions: {
      output: {
        extend: false,
        footer: "\nreturn __viboplrPlugin;",
        // The sandbox has no `document.currentScript` etc.; keep the bundle a
        // plain body with no module/preload plumbing.
        inlineDynamicImports: true,
      },
    },
    target: "es2020",
  },
});
