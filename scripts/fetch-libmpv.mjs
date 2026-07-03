#!/usr/bin/env node
// Fetches the pinned libmpv artifacts (scripts/libmpv.lock.json) into
// src-tauri/vendor/libmpv/<platform>/ for the `mpv-engine` Cargo feature.
//
//   node scripts/fetch-libmpv.mjs           # current platform only
//   node scripts/fetch-libmpv.mjs --all     # every platform in the lock file
//   node scripts/fetch-libmpv.mjs --force   # re-fetch even if stamp matches
//
// macOS post-processing: the eko5624 dylib references luajit via an absolute
// CI-runner path — rewritten to @rpath and ad-hoc re-signed (install_name_tool
// invalidates the signature). A libmpv.dylib symlink is created so `-lmpv`
// resolves at link time.

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
  const mpvDylib = path.join(libDir, "libmpv.2.dylib");
  // Rewrite any absolute (CI-runner) luajit reference to @rpath.
  const otool = execFileSync("otool", ["-L", mpvDylib], { encoding: "utf8" });
  for (const line of otool.split("\n")) {
    const m = line.trim().match(/^(\/\S*libluajit[^\s]*\.dylib)/);
    if (m) {
      const base = path.basename(m[1]);
      console.log(`  rewriting ${m[1]} -> @rpath/${base}`);
      execFileSync("install_name_tool", ["-change", m[1], `@rpath/${base}`, mpvDylib]);
    }
  }
  for (const f of fs.readdirSync(libDir).filter((f) => f.endsWith(".dylib") && !fs.lstatSync(path.join(libDir, f)).isSymbolicLink())) {
    execFileSync("codesign", ["-f", "-s", "-", path.join(libDir, f)]);
  }
  const linkName = path.join(libDir, "libmpv.dylib");
  fs.rmSync(linkName, { force: true });
  fs.symlinkSync("libmpv.2.dylib", linkName);
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
    console.log(`${platform}: up to date (${entry.sha256.slice(0, 12)}…)`);
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
