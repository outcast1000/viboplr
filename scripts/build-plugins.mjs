#!/usr/bin/env node
// Builds every bundled plugin that has a build step.
//
// A plugin the host can load is a single file evaluated as a function body that
// returns its exports. Plugins that want modules / TypeScript / tests therefore
// need a bundler — but only author-side: the emitted `index.js` is the same shape
// the loader has always taken, so nothing in the host changes and hand-written
// plugins keep working untouched.
//
// A plugin opts in simply by having a `vite.config.ts`. The built `index.js` is
// committed, because `tauri.conf.json` ships `plugins/` wholesale as a resource
// and a missing bundle would mean shipping a broken plugin.

import { readdirSync, existsSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = join(root, "src-tauri", "plugins");

const built = [];
for (const name of readdirSync(pluginsDir).sort()) {
  const dir = join(pluginsDir, name);
  if (!existsSync(join(dir, "vite.config.ts"))) continue;

  execFileSync("npx", ["vite", "build", "--config", join(dir, "vite.config.ts")], {
    cwd: dir,
    stdio: "inherit",
  });

  // Vite refuses to emit straight into its own root, so it writes to dist/ and
  // we move the one artifact into place.
  const from = join(dir, "dist", "index.js");
  if (!existsSync(from)) {
    throw new Error(`Plugin ${name}: expected a bundle at ${from}`);
  }
  renameSync(from, join(dir, "index.js"));
  rmSync(join(dir, "dist"), { recursive: true, force: true });
  built.push(name);
}

console.log(
  built.length ? `Built plugin bundles: ${built.join(", ")}` : "No plugins with a build step.",
);
