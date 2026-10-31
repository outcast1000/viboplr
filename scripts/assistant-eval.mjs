#!/usr/bin/env node
// The assistant eval: Claude, driving the real app through the MCP server,
// graded on a set of prompts (tests/assistant-eval/cases.json). It measures
// what the contract tests can't — whether a model, given only the tool
// descriptions and the server instructions, picks the right tools with the
// right arguments and keeps to the safety rules — and what each run costs.
//
//   npm run eval:setup -- --music ~/ViboplrDemo [--yes]
//   npm run eval:assistant -- [--case id,id] [--repeat 3] [--model sonnet]
//                              [--save --note "..."] [--yes]
//
// It runs against the `perf-eval` profile: the demo library (npm run
// demo:library) copied to <root>/music, set up by setup-demo-profile.mjs, then
// snapshotted. Before any case that follows a change, the profile AND the
// music copy are restored from that snapshot (APFS clones, so a 1.4 GB library
// restores in a moment) — write cases change the files, not just the database.
//
// The app is single-instance: running this QUITS whatever Viboplr is running
// and relaunches it under perf-eval. It refuses unless the app is already on
// perf-eval or you pass --yes.
//
// Every decision (parsing the CLI's stream, grading, the summary) lives in
// scripts/lib/assistantEval.mjs; this file launches, resets, runs and prints.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.VIBOPLR_PROBE_PROFILE ??= "perf-eval";
const ac = await import("./lib/appControl.mjs");
const ev = await import("./lib/assistantEval.mjs");
const { TOOLS, isReadOnlyCall } = await import("../mcp/tools.mjs");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASES_FILE = join(REPO, "tests", "assistant-eval", "cases.json");
const HISTORY_FILE = join(REPO, "benchmarks", "assistant-eval.json");
const PROFILE = ac.PROBE_PROFILE;
const PROFILE_DIR = dirname(ac.probeDumpPath(PROFILE));
const SCOPE_KEYS = ["modifyTags", "manageFiles", "downloads", "pluginActions", "deleteTracks", "uiInput"];
const TURN_TIMEOUT_MS = 10 * 60_000;
const SETTLE_MS = 1500; // mutations answer before the UI settles

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("--") ? argv.shift() : "run";
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}
const flag = (name) => argv.includes(`--${name}`);
const expand = (p) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

const ROOT = expand(opt("root", "~/ViboplrEval"));
const MUSIC = join(ROOT, "music");
const MUSIC_BASELINE = join(ROOT, "music.baseline");
const PROFILE_BASELINE = join(ROOT, "profile.baseline");
if (opt("app")) ac.setAppBundle(expand(opt("app")));

// ------------------------------------------------------------------ fs helpers

/** Copy a tree as an APFS clone (`cp -c`): instant and space-free for the
 *  music copy. Falls back to a plain copy where cloning isn't supported. */
function cloneTree(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  let r = spawnSync("cp", ["-cR", from, to], { encoding: "utf8" });
  if (r.status !== 0) r = spawnSync("cp", ["-R", from, to], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`copying ${from} → ${to} failed: ${r.stderr}`);
}

function writeScopes(scopes = []) {
  const unknown = scopes.filter((s) => !SCOPE_KEYS.includes(s));
  if (unknown.length) throw new Error(`unknown scope(s): ${unknown.join(", ")} (known: ${SCOPE_KEYS.join(", ")})`);
  const file = Object.fromEntries(SCOPE_KEYS.map((k) => [k, scopes.includes(k)]));
  writeFileSync(join(PROFILE_DIR, "assistant-permissions.json"), JSON.stringify(file, null, 2));
}

function setPaused(on) {
  const marker = join(PROFILE_DIR, "assistant-paused");
  if (on) writeFileSync(marker, "");
  else rmSync(marker, { force: true });
}

/** Refuse to quit a Viboplr the user is using unless they said so. */
function guardRunningApp() {
  if (!ac.appPids().length || ac.onProbeProfile() || flag("yes")) return;
  throw new Error(
    `Viboplr is running on another profile. This quits it and relaunches under "${PROFILE}" ` +
      `(your queue and position are not restored). Re-run with --yes to go ahead.`,
  );
}

// ------------------------------------------------------------------ app

const api = ac.controlApiClient(PROFILE_DIR);

/** Wait for the relaunched app's control API, and check it is this profile. */
async function waitForApi() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const health = await api("GET", "/health");
      if (health.profile !== PROFILE) throw new Error(`the control API answering is profile "${health.profile}"`);
      return health;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`the control API never came up: ${e.message}`, { cause: e });
      await ac.sleep(1000);
    }
  }
}

/** Back to the snapshot: profile + music, then the case's own files. */
async function reset(files = []) {
  await ac.quitApp();
  cloneTree(PROFILE_BASELINE, PROFILE_DIR);
  rmSync(join(PROFILE_DIR, "control-api.json"), { force: true });
  cloneTree(MUSIC_BASELINE, MUSIC);
  for (const f of files) {
    const target = resolve(MUSIC, f.path);
    if (!target.startsWith(MUSIC + "/")) throw new Error(`case file escapes the music copy: ${f.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
  }
  await ac.launchApp();
  return waitForApi();
}

// ------------------------------------------------------------------ setup

async function setup() {
  if (process.platform !== "darwin") throw new Error("the assistant eval runs on macOS (APFS clones, the probe links)");
  if (!/^perf-eval$/.test(PROFILE)) throw new Error(`setup wipes its profile, so it only runs on perf-eval (got ${PROFILE})`);
  const source = opt("music");
  const src = source ? expand(source) : null;
  if (src && !existsSync(join(src, "demo-library.json"))) throw new Error(`${src} is not a demo library (no demo-library.json)`);
  guardRunningApp();
  await ac.quitApp();
  console.log(`Eval root ${ROOT}\nProfile "${PROFILE}" at ${PROFILE_DIR}`);
  rmSync(PROFILE_DIR, { recursive: true, force: true });
  rmSync(MUSIC, { recursive: true, force: true });
  // --music only seeds the copy: the generator then fills in whatever the
  // catalog has gained since that library was made (it skips files that
  // exist), so a stale library can't leave the eval without an album its
  // cases rely on — and the source library itself is never written to.
  if (src) {
    cloneTree(src, MUSIC);
    console.log(`✓ seeded from ${src}`);
  }
  const gen = spawnSync(process.execPath, [join(REPO, "scripts", "make-demo-library.mjs"), "--out", MUSIC], { stdio: "inherit" });
  if (gen.status !== 0) throw new Error("make-demo-library failed");
  console.log("✓ music ready");
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "setup-demo-profile.mjs"), "--music", MUSIC], {
    stdio: "inherit",
    env: { ...process.env, VIBOPLR_PROBE_PROFILE: PROFILE },
  });
  if (r.status !== 0) throw new Error("setup-demo-profile failed");
  await ac.quitApp();
  cloneTree(PROFILE_DIR, PROFILE_BASELINE);
  rmSync(join(PROFILE_BASELINE, "control-api.json"), { force: true });
  cloneTree(MUSIC, MUSIC_BASELINE);
  console.log(`\n✓ baseline saved. Run the eval with:  npm run eval:assistant`);
}

// ------------------------------------------------------------------ claude

function mcpServerPath() {
  if (opt("mcp", "repo") === "bundled") return join(ac.resolveAppBundle(), "Contents", "Resources", "mcp", "viboplr-mcp.mjs");
  return join(REPO, "mcp", "viboplr-mcp.mjs");
}

function claudeVersion() {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("the claude CLI is not on PATH");
  return r.stdout.trim();
}

/** One `claude -p` turn, in an empty work dir (no project CLAUDE.md) with
 *  only the viboplr MCP server and none of the built-in tools, so the model
 *  can't reach around the server. `--setting-sources project` keeps the
 *  user's own hooks out. */
function runTurn({ work, mcpConfig, prompt, sessionId, resume, model, budget, logFile }) {
  const args = [
    "-p", prompt,
    resume ? "--resume" : "--session-id", sessionId,
    "--output-format", "stream-json", "--verbose",
    "--setting-sources", "project",
    "--strict-mcp-config", "--mcp-config", mcpConfig,
    "--allowedTools", "mcp__viboplr",
    "--tools", "",
    "--max-budget-usd", String(budget),
  ];
  if (model) args.push("--model", model);
  return new Promise((done) => {
    const child = spawn("claude", args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let pending = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), TURN_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      out += d;
      // Print each tool call as it streams in, so a long case isn't silent.
      pending += d;
      let nl;
      while ((nl = pending.indexOf("\n")) !== -1) {
        for (const l of ev.liveLines(pending.slice(0, nl))) console.log(`    ${l}`);
        pending = pending.slice(nl + 1);
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(logFile, out);
      if (err.trim()) writeFileSync(logFile.replace(/\.jsonl$/, ".err"), err);
      done({ turn: ev.parseStream(out.split("\n")), code, stderr: err.trim() });
    });
  });
}

async function readState(checks) {
  const out = [];
  for (const c of checks ?? []) {
    try {
      out.push({ value: c.sql ? await api("POST", "/query", { sql: c.sql }) : await api("GET", c.get) });
    } catch (e) {
      out.push({ error: e.message });
    }
  }
  return out;
}

/** True when the run (or its setup) may have changed the profile. Decided
 *  from the catalog's own read-only classification of each call the model
 *  actually made; a plugin proxy tool is assumed to change something. */
function leftDirty(spec, calls) {
  if (spec.files?.length || (spec.setup ?? []).some((s) => s.method !== "GET")) return true;
  return calls.some((c) => {
    const tool = TOOLS.find((t) => t.name === c.tool);
    return !tool || !isReadOnlyCall(tool, c.args);
  });
}

// ------------------------------------------------------------------ run

function printRun(r) {
  const mark = r.status === "pass" ? "✓ pass" : r.status === "fail" ? "✗ FAIL" : "? invalid";
  console.log(
    `  ${mark}  $${r.costUsd.toFixed(4)}  ${(r.durationMs / 1000).toFixed(1)}s  ` +
      `${r.calls.length} call${r.calls.length === 1 ? "" : "s"}`,
  );
  for (const f of r.failures) console.log(`    · ${f}`);
}

async function runEval() {
  if (!existsSync(PROFILE_BASELINE) || !existsSync(MUSIC_BASELINE)) {
    throw new Error(`no eval baseline at ${ROOT} — run: npm run eval:setup -- --music <demo library dir>`);
  }
  const all = JSON.parse(readFileSync(CASES_FILE, "utf8")).cases;
  const only = opt("case")?.split(",").map((s) => s.trim());
  const cases = only ? all.filter((c) => only.includes(c.id)) : all;
  const missing = only?.filter((id) => !all.some((c) => c.id === id)) ?? [];
  if (missing.length) throw new Error(`unknown case(s): ${missing.join(", ")}`);
  const repeat = Number(opt("repeat", "1"));
  const budget = Number(opt("max-budget", "2"));
  const maxTotal = Number(opt("max-total", "25"));
  const model = opt("model");
  const version = claudeVersion();

  guardRunningApp();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(ROOT, "runs", stamp);
  const work = join(runDir, "work");
  mkdirSync(work, { recursive: true });
  const mcpConfig = join(runDir, "mcp.json");
  const serverPath = mcpServerPath();
  if (!existsSync(serverPath)) throw new Error(`MCP server not found at ${serverPath}`);
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { viboplr: { command: process.execPath, args: [serverPath, `--profile=${PROFILE}`] } } }, null, 2));

  console.log(`Assistant eval — ${cases.length} case${cases.length === 1 ? "" : "s"} × ${repeat}, ${version}, model ${model ?? "(CLI default)"}`);
  console.log(`MCP server ${serverPath}\nTranscripts ${runDir}\n`);

  console.log("↺ restoring the eval profile and launching the app…");
  let health = await reset();
  let dirty = false;
  const runs = [];
  let spent = 0;
  const total = cases.length * repeat;
  const started = Date.now();
  outer: for (let rep = 1; rep <= repeat; rep++) {
    for (const spec of cases) {
      if (spent >= maxTotal) {
        console.log(`\n! stopped: spent $${spent.toFixed(2)}, the --max-total cap is $${maxTotal}`);
        break outer;
      }
      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(
        `\n▶ [${runs.length + 1}/${total}] ${spec.id}${repeat > 1 ? ` #${rep}` : ""}  ` +
          `($${spent.toFixed(4)} spent, ${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, "0")}s)`,
      );
      console.log(`  you: ${spec.prompt}`);
      if (dirty || spec.files?.length) {
        console.log("  ↺ restoring the profile (the last case changed it)…");
        health = await reset(spec.files);
      }
      setPaused(false);
      writeScopes(spec.scopes);
      for (const s of spec.setup ?? []) await api(s.method, s.path, s.body);
      if (spec.paused) setPaused(true);
      if (spec.appStopped) {
        console.log("  ■ quitting the app (this case starts with it stopped)…");
        await ac.quitApp();
      }

      const sessionId = randomUUID();
      const turns = [];
      const prompts = [spec.prompt, ...(spec.followUps ?? [])];
      for (let i = 0; i < prompts.length; i++) {
        if (i > 0) console.log(`  you: ${prompts[i]}`);
        const logFile = join(runDir, `${spec.id}.${rep}.turn${i + 1}.jsonl`);
        const { turn, code, stderr } = await runTurn({ work, mcpConfig, prompt: prompts[i], sessionId, resume: i > 0, model, budget, logFile });
        turns.push(turn);
        if (code !== 0 && !turn.result) {
          console.log(`  ! claude exited ${code}${stderr ? `: ${stderr.split("\n")[0]}` : ""}`);
          break;
        }
      }
      setPaused(false);
      await ac.sleep(SETTLE_MS);
      const merged = ev.mergeTurns(turns);
      const state = await readState(spec.expect?.state);
      const grade = ev.gradeCase(spec, merged, state);
      const run = { case: spec.id, category: spec.category, repeat: rep, ...merged, ...grade };
      runs.push(run);
      spent += run.costUsd;
      printRun(run);
      // A case that started with the app stopped may leave it stopped (or
      // launched by the model): either way the next case starts from a reset.
      dirty = spec.appStopped || leftDirty(spec, merged.calls);
    }
    if (rep === 1 && repeat > 1) {
      console.log(`\n  first pass cost $${spent.toFixed(4)} → about $${(spent * repeat).toFixed(2)} for all ${repeat}\n`);
    }
  }
  await ac.quitApp();

  const summary = ev.summarize(runs);
  const cov = ev.coverage(runs, TOOLS.map((t) => t.name));
  writeFileSync(join(runDir, "runs.json"), JSON.stringify(runs, null, 2));
  writeFileSync(join(runDir, "summary.json"), JSON.stringify({ summary, coverage: cov }, null, 2));

  console.log("\n case                    pass     mean cost   mean time  calls");
  for (const [id, c] of Object.entries(summary.cases)) {
    console.log(
      ` ${id.padEnd(23)} ${`${c.passed}/${c.valid}`.padEnd(8)} $${c.meanCostUsd.toFixed(4).padStart(8)}  ${(c.meanDurationMs / 1000).toFixed(1).padStart(7)}s  ${c.meanCalls ?? "-"}`,
    );
  }
  const t = summary.totals;
  console.log(
    `\n total: ${t.passed}/${t.valid} passed (${ev.pct(t.passRate)})` +
      (t.runs > t.valid ? `, ${t.runs - t.valid} invalid` : "") +
      `, $${t.costUsd.toFixed(4)}, ${(t.durationMs / 1000).toFixed(0)}s of model time`,
  );
  console.log(` tokens: ${t.usage.input} in, ${t.usage.output} out, ${t.usage.cacheRead} cache read, ${t.usage.cacheWrite} cache write`);
  const basis = runs.find((r) => r.costBasis)?.costBasis;
  if (basis) console.log(` cost basis: ${basis} (Claude Code's estimate at API prices)`);
  console.log(` tools never called: ${cov.unused.join(", ") || "none"}`);
  console.log(` transcripts: ${runDir}`);

  if (flag("save")) {
    const history = existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, "utf8")) : [];
    const gitRev = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
    const entry = ev.historyEntry(summary, {
      date: new Date().toISOString(),
      note: opt("note", ""),
      gitRev,
      appVersion: health.version,
      claudeCli: version,
      model: runs.find((r) => r.model)?.model ?? model ?? null,
      mcp: opt("mcp", "repo"),
      repeat,
      costBasis: basis ?? null,
    });
    const prev = [...history].reverse().find((h) => h.model === entry.model);
    history.push(entry);
    writeFileSync(HISTORY_FILE, `${JSON.stringify(history, null, 2)}\n`);
    console.log(`\n✓ saved to ${HISTORY_FILE}`);
    for (const line of ev.historyDelta(prev, entry)) console.log(`   ${line}`);
  }
  if (t.valid === 0) process.exitCode = 2;
  else if (t.passed < t.valid) process.exitCode = 1;
}

// ------------------------------------------------------------------ main

const main = command === "setup" ? setup : command === "run" ? runEval : null;
if (!main) {
  console.error(`unknown command "${command}" — use setup or run`);
  process.exit(1);
}
main().catch((e) => {
  console.error(`\n✖ ${e.message}`);
  process.exit(1);
});
