// Smoke-tests the app you actually ship, and records its startup cost.
//
// Why this exists: nothing else in the repo touches a built .app. The Playwright
// suite drives the Vite dev server with tests/e2e/tauri-mock.js faking the IPC
// layer, and `cargo test --lib` never renders anything — so the whole class of
// "the bundle is broken" bugs escapes both. Missing libmpv, a deep-link scheme
// that didn't register, codesigning that broke the webview, frontend assets left
// out of the bundle, a migration that crashes on a real profile: every one of
// those ships green today.
//
// It works by launching the installed app under the `perf` profile and asking it
// to describe itself through the viboplr://probe deep link (see
// src/utils/probeControl.ts). That the answer arrives at all is most of the test
// — it means the bundle launched, the webview mounted, React ran, the database
// opened and the URL scheme is registered to this build.
//
// Usage:
//   node scripts/app-smoke.mjs                      launch, check, report
//   node scripts/app-smoke.mjs --expect-version 1.0.38   also pin the version
//   node scripts/app-smoke.mjs --save [--note "..."]     append to the startup series
//   node scripts/app-smoke.mjs --keep-open               don't quit afterwards
//
// macOS only, and it needs the one-time `perf` profile setup described in
// CLAUDE.md. Exits non-zero on any failed check.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  quitApp,
  launchApp,
  probeLink,
  probeDumpPath,
  resolveAppBundle,
  waitFor,
  PROBE_PROFILE,
} from "./lib/appControl.mjs";
import { checkDump, startupEntry, startupDelta } from "./lib/appSmoke.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STARTUP_HISTORY = join(REPO_ROOT, "benchmarks", "startup-history.json");

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
    else flags[a.slice(2)] = argv[++i];
  }
  return flags;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Launch the app and collect one dump.
 *
 * The stale-file delete before launching is load-bearing: the dump lands at a
 * fixed path, so a previous run's file is indistinguishable from this run's, and
 * an app that failed to start would otherwise be "verified" against the last
 * good launch — the exact failure this script exists to catch.
 */
async function collectDump() {
  const bundle = resolveAppBundle();
  if (!bundle) throw new Error('No application named "Viboplr" is registered — nothing to smoke-test.');
  console.log(`Smoke-testing: ${bundle}`);
  if (!bundle.startsWith("/Applications/")) {
    console.warn("  ! Not in /Applications — this is probably a dev build, not the shipped one.");
  }

  const dumpPath = probeDumpPath(PROBE_PROFILE);
  rmSync(dumpPath, { force: true });

  await quitApp();
  await launchApp();
  await probeLink("dump=on");

  await waitFor(() => existsSync(dumpPath), 30000, "the app to write its state dump").catch(() => {
    throw new Error(
      `No dump appeared at ${dumpPath}.\n` +
        `The app launched but never answered the probe link. Either this build predates the ` +
        `probe route, or viboplr:// is registered to a different bundle.`,
    );
  });

  const dump = readJson(dumpPath, null);
  if (!dump) throw new Error(`Dump at ${dumpPath} is not valid JSON.`);
  return dump;
}

function recordStartup(dump, { version, note }) {
  const history = readJson(STARTUP_HISTORY, { entries: [] });
  const entries = Array.isArray(history.entries) ? history.entries : [];
  const prev = entries.at(-1) ?? null;
  const entry = startupEntry(dump, { version, note });
  const { spans, movers, incomparable } = startupDelta(prev, entry);

  console.log(
    `\nstartup: backend ${entry.backend_span_ms} ms · frontend ${entry.frontend_span_ms} ms` +
      (spans
        ? `  (Δ ${fmtDelta(spans.backend_span_ms)} / ${fmtDelta(spans.frontend_span_ms)})`
        : `  (${incomparable ?? "first entry"} — no delta)`),
  );
  for (const m of movers.slice(0, 5)) {
    console.log(`  ${fmtDelta(m.delta).padStart(8)} ms  ${m.side}/${m.label}`);
  }

  // Replace rather than append when the same version is measured twice, so a
  // re-run during a release doesn't leave two rows for one version.
  const without = entries.filter((e) => e.version !== entry.version);
  writeFileSync(STARTUP_HISTORY, `${JSON.stringify({ entries: [...without, entry] }, null, 2)}\n`);
  console.log(`Recorded in ${STARTUP_HISTORY.replace(REPO_ROOT, ".")}`);
}

function fmtDelta(n) {
  return `${n > 0 ? "+" : ""}${n}`;
}

async function main() {
  if (process.platform !== "darwin") {
    console.error("app-smoke is macOS only (osascript / open / pgrep).");
    process.exit(1);
  }
  const flags = parseArgs(process.argv.slice(2));
  const expectedVersion = typeof flags["expect-version"] === "string" ? flags["expect-version"] : null;

  let dump;
  try {
    dump = await collectDump();
  } finally {
    if (!flags["keep-open"]) await quitApp().catch(() => {});
  }

  const problems = checkDump(dump, { expectedVersion, expectedProfile: PROBE_PROFILE });
  console.log(
    `\n${dump.app?.version ?? "?"} · profile ${dump.app?.profile ?? "?"} · ` +
      `${dump.library?.trackCount ?? "?"} tracks · view ${dump.ui?.view ?? "?"}`,
  );

  if (problems.length) {
    console.error(`\n✖ ${problems.length} check(s) failed:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("✓ built app launches, mounts, opens its database and answers.");

  if (flags.save) {
    recordStartup(dump, {
      version: dump.app.version,
      note: typeof flags.note === "string" ? flags.note : null,
    });
  }
}

main().catch((e) => {
  console.error(`\n✖ ${e.message}`);
  process.exit(1);
});
