// Pure logic for the built-app smoke test (scripts/app-smoke.mjs).
//
// Split from the runner so the checks — the part that decides whether a release
// is broken — are unit-testable without launching anything. See
// src/__tests__/appSmoke.test.ts.

/**
 * Schema the dump must declare; mirrors PROBE_DUMP_SCHEMA in probeControl.ts.
 * The two are pinned equal by a test in src/__tests__/appSmoke.test.ts — they
 * have already drifted once, and the failure only showed up against a real build.
 */
export const EXPECTED_SCHEMA = 2;

/**
 * Check a probe dump against what a healthy launch must look like.
 *
 * Returns a list of human-readable failures — empty means pass. A list rather
 * than a throw so one run reports every problem at once; "version is wrong" and
 * "the database never opened" are independent facts and a release engineer
 * should see both without re-running a four-minute build.
 *
 * `expectedVersion` is optional: at release time it's package.json's version
 * (catching a bundle built from stale sources), ad hoc it's usually omitted.
 */
export function checkDump(dump, { expectedVersion = null, expectedProfile = "perf" } = {}) {
  const problems = [];

  if (!dump || typeof dump !== "object") {
    return ["dump is not an object — the app wrote nothing usable"];
  }
  if (dump.schema !== EXPECTED_SCHEMA) {
    problems.push(
      `dump schema is ${JSON.stringify(dump.schema)}, expected ${EXPECTED_SCHEMA} ` +
        `(the app and this script disagree about the format)`,
    );
    // Everything below reads fields this schema defines; with the wrong schema
    // those reads are meaningless, so stop rather than emit noise.
    return problems;
  }

  const version = dump.app?.version;
  if (!version || version === "unknown") {
    problems.push("app version missing — collect_diagnostics did not answer");
  } else if (expectedVersion && version !== expectedVersion) {
    problems.push(`app reports version ${version}, expected ${expectedVersion}`);
  }

  if (dump.app?.profile !== expectedProfile) {
    problems.push(`app is on profile ${JSON.stringify(dump.app?.profile)}, expected ${expectedProfile}`);
  }

  // trackCount is the cheapest proof the database actually opened and answered
  // a query. null means the invoke failed; 0 is a legitimately empty library.
  if (dump.library?.trackCount === null || dump.library?.trackCount === undefined) {
    problems.push("track count unavailable — the database did not answer");
  }

  if (typeof dump.ui?.view !== "string" || !dump.ui.view) {
    problems.push("no current view — the frontend did not finish mounting");
  }

  // A build whose backend timer recorded nothing did not run its startup path.
  if (!Array.isArray(dump.startup?.backend) || dump.startup.backend.length === 0) {
    problems.push("no backend startup timings — the Rust startup path did not record");
  }
  if (!Array.isArray(dump.startup?.frontend) || dump.startup.frontend.length === 0) {
    problems.push("no frontend startup timings — the webview did not record");
  }

  return problems;
}

/**
 * Compare a dump's UI state against what a probe scenario expected.
 *
 * Returns a human-readable mismatch string, or `null` when everything matches.
 * Only the keys present in `expected` are checked, so a scenario declares the
 * axes it cares about and ignores the rest.
 *
 * `playing: true` additionally requires a `currentTrack`: an empty perf-profile
 * queue leaves `playing` false, but a track that failed to *load* can leave the
 * flag optimistically true with nothing behind it — and either way the scenario
 * would sample an idle app while claiming to measure decode cost.
 */
export function compareState(dump, expected) {
  const ui = dump?.ui;
  if (!ui) return "dump carried no ui state";
  const wrong = [];
  for (const [key, want] of Object.entries(expected)) {
    if (want === undefined) continue;
    if (ui[key] !== want) wrong.push(`${key}=${JSON.stringify(ui[key])} (wanted ${JSON.stringify(want)})`);
  }
  if (expected.playing === true && !ui.currentTrack) {
    wrong.push("nothing is loaded (is the perf profile's queue empty?)");
  }
  return wrong.length ? wrong.join(", ") : null;
}

/**
 * One row of `benchmarks/startup-history.json`.
 *
 * The two spans stay separate all the way into the series for the reason given
 * in `buildProbeDump`: the timers have no shared zero, so there is no honest
 * single "startup took N ms". Per-phase breakdowns ride along so a regression
 * can be attributed without re-running.
 */
export function startupEntry(dump, { version, note = null, at = new Date() } = {}) {
  return {
    version,
    date: at.toISOString().slice(0, 10),
    backend_span_ms: round1(dump.startup.backendSpanMs),
    frontend_span_ms: round1(dump.startup.frontendSpanMs),
    backend: phaseMap(dump.startup.backend),
    frontend: phaseMap(dump.startup.frontend),
    ...(note ? { note } : {}),
  };
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/**
 * `[{label, duration_ms}]` → `{label: ms}`, keeping the slowest when a label
 * repeats (the timer does not enforce uniqueness, and silently dropping one of
 * two phases with the same name would hide exactly the phase that got slow).
 */
function phaseMap(entries) {
  const out = {};
  for (const e of entries ?? []) {
    const ms = round1(e.duration_ms);
    if (out[e.label] === undefined || ms > out[e.label]) out[e.label] = ms;
  }
  return out;
}

/**
 * Compare a new entry against the previous one, for the release printout.
 * Returns the movers past `thresholdMs`, largest regression first. Percentages
 * are deliberately absent: startup phases are often sub-millisecond, where a
 * percentage turns noise into a headline.
 */
export function startupDelta(prev, next, { thresholdMs = 20 } = {}) {
  if (!prev) return { spans: null, movers: [] };
  const spans = {
    backend_span_ms: round1(next.backend_span_ms - prev.backend_span_ms),
    frontend_span_ms: round1(next.frontend_span_ms - prev.frontend_span_ms),
  };
  const movers = [];
  for (const side of ["backend", "frontend"]) {
    const labels = new Set([...Object.keys(prev[side] ?? {}), ...Object.keys(next[side] ?? {})]);
    for (const label of labels) {
      const delta = round1((next[side]?.[label] ?? 0) - (prev[side]?.[label] ?? 0));
      if (Math.abs(delta) >= thresholdMs) movers.push({ side, label, delta });
    }
  }
  movers.sort((a, b) => b.delta - a.delta);
  return { spans, movers };
}
