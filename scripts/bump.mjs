#!/usr/bin/env node

// Usage: node scripts/bump.mjs [0.2.0] [--autocommit]

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const autocommit = args.includes("--autocommit");
let version = args.find((a) => !a.startsWith("--"));

if (!version) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const parts = pkg.version.split(".").map(Number);
  parts[parts.length - 1] += 1;
  version = parts.join(".");
  console.log(`No version specified, bumping patch: ${pkg.version} -> ${version}`);
}

console.log(`\nBumping version to ${version}...\n`);

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: node scripts/bump.mjs [version]  (e.g. 0.2.0)");
  process.exit(1);
}

const files = [
  { path: "package.json", replace: (s) => s.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`) },
  { path: "src-tauri/Cargo.toml", replace: (s) => s.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`) },
  { path: "src-tauri/tauri.conf.json", replace: (s) => s.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`) },
];

for (const { path, replace } of files) {
  const full = resolve(root, path);
  const before = readFileSync(full, "utf8");
  const after = replace(before);
  if (before === after) {
    console.error(`⚠ No version found to replace in ${path}`);
  } else {
    writeFileSync(full, after);
    console.log(`✓ ${path} → ${version}`);
  }
}

if (autocommit) {
  console.log("\nCommitting and tagging...\n");
  const run = (label, cmd) => {
    console.log(`${label}`);
    console.log(`  $ ${cmd}`);
    // Redirect stderr to stdout so we capture all git output (e.g. git push writes to stderr)
    const output = execSync(`${cmd} 2>&1`, { cwd: root, encoding: "utf8" }).trim();
    if (output) console.log(`  ${output.replace(/\n/g, "\n  ")}`);
    console.log();
  };
  run("Staging changes...", "git add -A");
  run("Creating release commit...", `git commit -m "release: v${version}"`);
  run("Tagging release...", `git tag v${version}`);
  run("Pushing to origin...", "git push origin main --tags");
  console.log(`Done! Released v${version}.`);
} else {
  console.log(`\nFiles updated. To commit and tag manually:\n`);
  console.log(`  git add -A`);
  console.log(`  git commit -m "release: v${version}"`);
  console.log(`  git tag v${version}`);
  console.log(`  git push origin main --tags`);
  console.log(`\nOr re-run with --autocommit to do this automatically.`);
}
