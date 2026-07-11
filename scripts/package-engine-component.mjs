#!/usr/bin/env node
// Packages the post-processed vendor libmpv (fetched by fetch-libmpv.mjs)
// into the flat, ready-to-load zips the app downloads at runtime as the
// "engine component" (src-tauri/src/mpv_engine/component.rs), and writes the
// computed SHA-256 pins back into src-tauri/engine-component.lock.json.
//
//   node scripts/fetch-libmpv.mjs --all          # first, if not already done
//   node scripts/package-engine-component.mjs    # all vendored platforms
//
// Output: dist/engine-component/engine-libmpv-<platform>-<version>.zip
//
// Publishing (one-time per pin bump, manual on purpose — the artifacts are
// packaged ONCE so the baked hashes always match the released bytes):
//   gh release create engine-components --title "Engine components" \
//     --notes "Runtime-downloadable libmpv engine components (hash-pinned by the app)." \
//     || true   # release may already exist
//   gh release upload engine-components dist/engine-component/*.zip --clobber
//
// The zip is flat: the dylibs/DLL at the root plus nothing else. The version
// in the filename and lock is the mpv git hash from scripts/libmpv.lock.json.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(root, "src-tauri", "vendor", "libmpv");
const outDir = path.join(root, "dist", "engine-component");
const mpvLock = JSON.parse(fs.readFileSync(path.join(root, "scripts", "libmpv.lock.json"), "utf8"));
const componentLockPath = path.join(root, "src-tauri", "engine-component.lock.json");
const componentLock = JSON.parse(fs.readFileSync(componentLockPath, "utf8"));

const RELEASE_TAG = "engine-components";

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function platformFiles(platform, libDir) {
  if (platform.startsWith("macos")) {
    // The mpv dylib + its @loader_path-referenced companions (luajit).
    return fs
      .readdirSync(libDir)
      .filter((f) => f.endsWith(".dylib") && !fs.lstatSync(path.join(libDir, f)).isSymbolicLink());
  }
  if (platform.startsWith("windows")) {
    return ["libmpv-2.dll"];
  }
  throw new Error(`unsupported platform ${platform}`);
}

fs.mkdirSync(outDir, { recursive: true });
let wroteLock = false;

for (const [platform, entry] of Object.entries(mpvLock.platforms)) {
  const libDir = path.join(vendorRoot, platform, "lib");
  if (!fs.existsSync(libDir)) {
    console.log(`${platform}: vendor dir missing — run \`node scripts/fetch-libmpv.mjs --all\` (skipped)`);
    continue;
  }
  const version = entry.mpvGitHash;
  const zipName = `engine-libmpv-${platform}-${version}.zip`;
  const zipPath = path.join(outDir, zipName);
  const files = platformFiles(platform, libDir);

  if (platform.startsWith("macos")) {
    // Guard: the component is loaded from an arbitrary dir with no exe
    // rpaths, so the luajit reference must already be @loader_path.
    const otool = execFileSync("otool", ["-L", path.join(libDir, "libmpv.2.dylib")], { encoding: "utf8" });
    if (/@rpath\/\S*libluajit/.test(otool) || /^\s*\/\S*libluajit/m.test(otool)) {
      throw new Error(
        `${platform}: libmpv.2.dylib still references luajit via @rpath or an absolute path — re-run \`node scripts/fetch-libmpv.mjs --force\``,
      );
    }
  }

  fs.rmSync(zipPath, { force: true });
  // -X drops extended attributes; -j stores bare filenames (flat archive).
  execFileSync("zip", ["-X", "-j", zipPath, ...files.map((f) => path.join(libDir, f))], {
    stdio: "inherit",
  });

  const hash = sha256(zipPath);
  const sizeMb = Math.round((fs.statSync(zipPath).size / 1e6) * 10) / 10;
  console.log(`${platform}: ${zipName}  sha256=${hash}  (${sizeMb} MB)`);

  const lockEntry = componentLock.platforms[platform];
  if (lockEntry) {
    lockEntry.version = version;
    lockEntry.url = `https://github.com/outcast1000/viboplr/releases/download/${RELEASE_TAG}/${zipName}`;
    lockEntry.sha256 = hash;
    lockEntry.size_mb = sizeMb;
    wroteLock = true;
  } else {
    console.warn(`${platform}: no entry in engine-component.lock.json — add one to publish this platform`);
  }
}

if (wroteLock) {
  fs.writeFileSync(componentLockPath, JSON.stringify(componentLock, null, 2) + "\n");
  console.log(`updated ${path.relative(root, componentLockPath)} — rebuild the app to bake the new pins`);
}
