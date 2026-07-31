#!/usr/bin/env node
// Fetches the pinned libmpv artifacts (scripts/libmpv.lock.json) into
// src-tauri/vendor/libmpv/<platform>/. libmpv is loaded at RUNTIME
// (src-tauri/src/mpv_engine/ffi.rs) — nothing links against it — so the
// vendor dir serves dev/test runs, the Full-build bundling configs, and
// scripts/package-engine-component.mjs (the downloadable component).
//
//   node scripts/fetch-libmpv.mjs           # current platform only
//   node scripts/fetch-libmpv.mjs --all     # every platform in the lock file
//   node scripts/fetch-libmpv.mjs --force   # re-fetch even if stamp matches
//
// macOS post-processing: the eko5624 dylib references luajit via an absolute
// CI-runner path — rewritten to @loader_path (same dir as the mpv dylib, so
// it resolves wherever the pair lands: Frameworks/, the engine-component
// dir, or the vendor dir — without any executable rpaths) and ad-hoc
// re-signed (install_name_tool invalidates the signature).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(root, "src-tauri", "vendor", "libmpv");
const lock = JSON.parse(fs.readFileSync(path.join(root, "scripts", "libmpv.lock.json"), "utf8"));

const args = process.argv.slice(2);
const force = args.includes("--force");

function hostPlatform() {
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${os}-${arch}`;
}

const wanted = args.includes("--all") ? Object.keys(lock.platforms) : [hostPlatform()];

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function download(url, dest) {
  console.log(`  downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function extract(archive, destDir) {
  // bsdtar handles .zip everywhere; its .7z support depends on the libarchive
  // build (Windows' System32 tar lacks it), so fall back to 7z there.
  try {
    execFileSync("tar", ["-xf", archive, "-C", destDir]);
  } catch (e) {
    console.log(`  tar failed (${e.message?.split("\n")[0]}), trying 7z`);
    execFileSync("7z", ["x", "-y", `-o${destDir}`, archive]);
  }
}

// Rewrite any absolute (CI-runner) or @rpath luajit reference to @loader_path —
// the two dylibs always ship side by side, so @loader_path resolves wherever the
// pair lands with no rpath from the loading executable. Idempotent: once the
// reference is @loader_path the regex stops matching and this is a no-op.
// Returns whether anything changed (callers must re-sign if so).
function rewriteLuajitRef(platformDir) {
  const mpvDylib = path.join(platformDir, "lib", "libmpv.2.dylib");
  if (!fs.existsSync(mpvDylib)) return false;
  const otool = execFileSync("otool", ["-L", mpvDylib], { encoding: "utf8" });
  let changed = false;
  for (const line of otool.split("\n")) {
    const m = line.trim().match(/^((?:\/\S*|@rpath\/\S*)libluajit[^\s]*\.dylib)/);
    if (m) {
      const base = path.basename(m[1]);
      console.log(`  rewriting ${m[1]} -> @loader_path/${base}`);
      execFileSync("install_name_tool", ["-change", m[1], `@loader_path/${base}`, mpvDylib]);
      changed = true;
    }
  }
  return changed;
}

// install_name_tool invalidates the signature, so every rewrite needs a re-sign.
function signDylibs(libDir) {
  for (const f of fs.readdirSync(libDir).filter((f) => f.endsWith(".dylib") && !fs.lstatSync(path.join(libDir, f)).isSymbolicLink())) {
    execFileSync("codesign", ["-f", "-s", "-", path.join(libDir, f)]);
  }
}

function postProcessMacos(platformDir) {
  const libDir = path.join(platformDir, "lib");
  const extracted = path.join(platformDir, "_extract", "libmpv");
  fs.mkdirSync(libDir, { recursive: true });
  for (const f of fs.readdirSync(extracted)) {
    const src = path.join(extracted, f);
    if (f === "include") {
      fs.cpSync(src, path.join(platformDir, "include"), { recursive: true });
    } else if (f.endsWith(".dylib")) {
      fs.cpSync(src, path.join(libDir, f));
    }
  }
  rewriteLuajitRef(platformDir);
  signDylibs(libDir);
}

function postProcessWindows(platformDir) {
  const libDir = path.join(platformDir, "lib");
  const extracted = path.join(platformDir, "_extract");
  fs.mkdirSync(libDir, { recursive: true });
  fs.cpSync(path.join(extracted, "libmpv-2.dll"), path.join(libDir, "libmpv-2.dll"));
  // MSVC `link.exe` accepts the MinGW import library under the name -lmpv expects.
  fs.cpSync(path.join(extracted, "libmpv.dll.a"), path.join(libDir, "mpv.lib"));
  fs.cpSync(path.join(extracted, "include"), path.join(platformDir, "include"), { recursive: true });
}

for (const platform of wanted) {
  const entry = lock.platforms[platform];
  if (!entry) {
    console.error(`No lock entry for platform "${platform}" — nothing to fetch.`);
    process.exitCode = 1;
    continue;
  }
  const platformDir = path.join(vendorRoot, platform);
  const stamp = path.join(platformDir, ".stamp");
  if (!force && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === entry.sha256) {
    // The stamp records the ARCHIVE's identity, not the post-processing recipe.
    // A vendor dir fetched before a post-processing fix would otherwise report
    // "up to date" forever while holding a dylib that can't be dlopen'd (a stale
    // @rpath/libluajit ref resolves only on the CI runner that built it, so every
    // real-mpv test silently self-skips). Re-assert the rewrite in place — it
    // needs no re-download, and is a no-op once correct.
    if (platform.startsWith("macos") && rewriteLuajitRef(platformDir)) {
      signDylibs(path.join(platformDir, "lib"));
      console.log(`${platform}: repaired stale install names in place`);
    } else {
      console.log(`${platform}: up to date (${entry.sha256.slice(0, 12)}…)`);
    }
    continue;
  }
  console.log(`${platform}: fetching libmpv (${entry.source})`);
  fs.rmSync(platformDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(platformDir, "_extract"), { recursive: true });
  const archive = path.join(platformDir, path.basename(new URL(entry.url).pathname));
  await download(entry.url, archive);
  const actual = sha256(archive);
  if (actual !== entry.sha256) {
    fs.rmSync(platformDir, { recursive: true, force: true });
    throw new Error(`${platform}: SHA-256 mismatch!\n  expected ${entry.sha256}\n  actual   ${actual}`);
  }
  extract(archive, path.join(platformDir, "_extract"));
  if (platform.startsWith("macos")) postProcessMacos(platformDir);
  else if (platform.startsWith("windows")) postProcessWindows(platformDir);
  fs.rmSync(path.join(platformDir, "_extract"), { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
  fs.writeFileSync(stamp, entry.sha256 + "\n");
  console.log(`${platform}: done -> ${platformDir}`);
}
