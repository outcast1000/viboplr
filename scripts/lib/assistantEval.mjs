// The assistant eval's decisions, kept apart from the runner
// (scripts/assistant-eval.mjs) so they are assertable without a model, an app
// or a network — the same split as appSmoke.mjs. Pinned by
// src/__tests__/assistantEval.test.ts.
//
// A case (tests/assistant-eval/cases.json) is a prompt, optional follow-up
// turns, and expectations graded against what the model DID: the tool calls
// it made (name + arguments), the app state afterwards, and — loosely — its
// final answer. Tool calls carry most of the weight because they are
// deterministic to check; the answer checks are substring/regex only.

export const MCP_PREFIX = "mcp__viboplr__";

/** One `claude -p --output-format stream-json` turn → what the grader needs.
 *  Hook, thinking and rate-limit events are ignored; a run whose MCP server
 *  did not connect is reported through `mcpConnected`, so the caller can
 *  mark it invalid instead of failed. */
export function parseStream(lines) {
  const turn = {
    model: null,
    mcpConnected: false,
    toolCount: 0,
    hookEvents: 0,
    calls: [],
    answer: "",
    result: null,
  };
  const byId = new Map();
  for (const raw of lines) {
    const line = typeof raw === "string" ? raw.trim() : raw;
    if (!line) continue;
    let m;
    try {
      m = typeof line === "string" ? JSON.parse(line) : line;
    } catch {
      continue; // a stray non-JSON line (stderr bleed) is not an event
    }
    if (m.type === "system" && m.subtype === "init") {
      turn.model = m.model ?? null;
      turn.toolCount = (m.tools ?? []).filter((t) => t.startsWith(MCP_PREFIX)).length;
      turn.mcpConnected = (m.mcp_servers ?? []).some((s) => s.name === "viboplr" && s.status === "connected");
    } else if (m.type === "system" && /^hook_/.test(m.subtype ?? "")) {
      turn.hookEvents++;
    } else if (m.type === "assistant") {
      for (const c of m.message?.content ?? []) {
        if (c.type !== "tool_use") continue;
        const call = { tool: toolName(c.name), args: c.input ?? {}, isError: false, result: "" };
        byId.set(c.id, call);
        turn.calls.push(call);
      }
    } else if (m.type === "user") {
      for (const c of m.message?.content ?? []) {
        if (c.type !== "tool_result") continue;
        const call = byId.get(c.tool_use_id);
        if (!call) continue;
        call.isError = c.is_error === true;
        call.result = resultText(c.content).slice(0, 500);
      }
    } else if (m.type === "result") {
      turn.answer = typeof m.result === "string" ? m.result : "";
      turn.result = {
        subtype: m.subtype ?? null,
        costUsd: Number(m.total_cost_usd) || 0,
        durationMs: Number(m.duration_ms) || 0,
        numTurns: Number(m.num_turns) || 0,
        sessionId: m.session_id ?? null,
        usage: usageOf(m.usage),
        costBasis: Object.values(m.modelUsage ?? {})[0]?.costBasis ?? null,
      };
    }
  }
  return turn;
}

/** `mcp__viboplr__browse` → `browse`; a plugin proxy keeps its own `__`. */
export function toolName(name) {
  return name?.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name ?? "";
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  return "";
}

function usageOf(u = {}) {
  return {
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cacheRead: Number(u.cache_read_input_tokens) || 0,
    cacheWrite: Number(u.cache_creation_input_tokens) || 0,
  };
}

/** Several turns of one case (first prompt, then each `--resume`) → one
 *  record. Cost and tokens are summed over every turn: each turn is its own
 *  `result` event and its own bill. */
export function mergeTurns(turns) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let costUsd = 0;
  let durationMs = 0;
  let numTurns = 0;
  for (const t of turns) {
    if (!t.result) continue;
    costUsd += t.result.costUsd;
    durationMs += t.result.durationMs;
    numTurns += t.result.numTurns;
    for (const k of Object.keys(usage)) usage[k] += t.result.usage[k];
  }
  const last = turns[turns.length - 1];
  return {
    model: turns.find((t) => t.model)?.model ?? null,
    mcpConnected: turns.length > 0 && turns.every((t) => t.mcpConnected),
    hookEvents: turns.reduce((n, t) => n + t.hookEvents, 0),
    calls: turns.flatMap((t) => t.calls),
    answers: turns.map((t) => t.answer),
    answer: last?.answer ?? "",
    completed: turns.length > 0 && turns.every((t) => t.result?.subtype === "success"),
    costUsd,
    durationMs,
    numTurns,
    usage,
    costBasis: turns.find((t) => t.result?.costBasis)?.result.costBasis ?? null,
  };
}

// ---------------------------------------------------------------------------
// Matching

/** Does `actual` satisfy `want`? Objects match as subsets (keys `want`
 *  names), arrays and scalars by equality, plus three operators:
 *  `{ "$absent": true }`, `{ "$present": true }`, `{ "$match": "regex" }`
 *  (case-insensitive, on the value's string form). */
export function valueMatches(want, actual) {
  if (want && typeof want === "object" && !Array.isArray(want)) {
    if ("$absent" in want) return actual === undefined || actual === null;
    if ("$present" in want) return actual !== undefined && actual !== null;
    if ("$match" in want) return actual !== undefined && actual !== null && new RegExp(want.$match, "i").test(String(actual));
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(want).every(([k, v]) => valueMatches(v, actual[k]));
  }
  if (Array.isArray(want)) {
    return Array.isArray(actual) && want.length === actual.length && want.every((v, i) => valueMatches(v, actual[i]));
  }
  return want === actual;
}

/** A call spec is a tool name or `{ tool, args? }`. */
export function callMatches(spec, call) {
  const s = typeof spec === "string" ? { tool: spec } : spec;
  return s.tool === call.tool && (s.args === undefined || valueMatches(s.args, call.args));
}

/** Read `a.b.0.c` out of a value. */
export function at(value, path) {
  if (!path) return value;
  return String(path).split(".").reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), value);
}

/** One state check against the value it read. Ops: equals, matches, gte,
 *  lte, includes (array element or substring), some (an array element
 *  matching a subset). */
export function checkValue(check, value) {
  if ("equals" in check) return valueMatches(check.equals, value);
  if ("matches" in check) return value !== undefined && value !== null && new RegExp(check.matches, "i").test(String(value));
  if ("gte" in check) return Number(value) >= check.gte;
  if ("lte" in check) return Number(value) <= check.lte;
  if ("includes" in check) {
    if (Array.isArray(value)) return value.some((v) => valueMatches(check.includes, v));
    return typeof value === "string" && value.toLowerCase().includes(String(check.includes).toLowerCase());
  }
  if ("some" in check) return Array.isArray(value) && value.some((v) => valueMatches(check.some, v));
  return false;
}

function describeCall(spec) {
  return typeof spec === "string" ? spec : `${spec.tool}${spec.args ? " " + JSON.stringify(spec.args) : ""}`;
}

// ---------------------------------------------------------------------------
// Grading

/**
 * Grade one run. `run` is mergeTurns' record; `state` maps each state check's
 * index to `{ value }` or `{ error }` (the runner reads them from the app after
 * the last turn). Returns `{ status, failures }`: `invalid` when the run
 * never had working tools (server not connected, or the CLI failed), so it is
 * left out of the pass rate rather than counted as the model's failure.
 */
export function gradeCase(spec, run, state = []) {
  if (!run.mcpConnected) return { status: "invalid", failures: ["the viboplr MCP server did not connect"] };
  if (!run.completed) return { status: "invalid", failures: ["the claude CLI did not finish every turn"] };
  const expect = spec.expect ?? {};
  const failures = [];

  // Ordered: each spec must match a call after the previous match.
  let from = 0;
  for (const want of expect.calls ?? []) {
    const i = run.calls.findIndex((c, idx) => idx >= from && callMatches(want, c));
    if (i === -1) {
      const near = run.calls.filter((c) => c.tool === (typeof want === "string" ? want : want.tool));
      failures.push(
        `expected call ${describeCall(want)}` +
          (near.length ? ` (got ${near.map((c) => JSON.stringify(c.args)).join(", ")})` : " (never called)"),
      );
    } else {
      from = i + 1;
    }
  }
  for (const banned of expect.forbidden ?? []) {
    const hit = run.calls.find((c) => callMatches(banned, c));
    if (hit) failures.push(`forbidden call ${describeCall(banned)}: ${hit.tool} ${JSON.stringify(hit.args)}`);
  }
  if (expect.maxCalls !== undefined && run.calls.length > expect.maxCalls) {
    failures.push(`${run.calls.length} tool calls, more than ${expect.maxCalls}`);
  }

  const answer = run.answer ?? "";
  const a = expect.answer ?? {};
  for (const s of a.includes ?? []) if (!answer.toLowerCase().includes(s.toLowerCase())) failures.push(`answer lacks "${s}"`);
  for (const s of a.excludes ?? []) if (answer.toLowerCase().includes(s.toLowerCase())) failures.push(`answer contains "${s}"`);
  if (a.matches && !new RegExp(a.matches, "i").test(answer)) failures.push(`answer doesn't match /${a.matches}/i`);

  (expect.state ?? []).forEach((check, i) => {
    const got = state[i];
    const label = check.sql ? `sql ${check.sql}` : `${check.get}`;
    if (!got) failures.push(`state ${label}: not read`);
    else if (got.error) failures.push(`state ${label}: ${got.error}`);
    else if (!checkValue(check, at(got.value, check.at))) {
      failures.push(`state ${label}${check.at ? " @" + check.at : ""}: got ${JSON.stringify(at(got.value, check.at))}, wanted ${JSON.stringify(stripCheck(check))}`);
    }
  });
  return { status: failures.length ? "fail" : "pass", failures };
}

function stripCheck(check) {
  const { get: _get, sql: _sql, at: _at, ...ops } = check;
  return ops;
}

// ---------------------------------------------------------------------------
// Reporting

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Per case and overall: pass rate over the valid runs, and cost. Invalid
 *  runs still cost money, so they count toward the totals. */
export function summarize(runs) {
  const cases = {};
  for (const r of runs) {
    const c = (cases[r.case] ??= { runs: 0, valid: 0, passed: 0, costs: [], durations: [], calls: [], failures: [] });
    c.runs++;
    c.costs.push(r.costUsd);
    c.durations.push(r.durationMs);
    if (r.status === "invalid") continue;
    c.valid++;
    c.calls.push(r.calls.length);
    if (r.status === "pass") c.passed++;
    else c.failures.push(...r.failures);
  }
  const out = {};
  for (const [id, c] of Object.entries(cases)) {
    out[id] = {
      runs: c.runs,
      valid: c.valid,
      passed: c.passed,
      passRate: c.valid ? c.passed / c.valid : null,
      meanCostUsd: mean(c.costs),
      meanDurationMs: Math.round(mean(c.durations)),
      meanCalls: c.calls.length ? Number(mean(c.calls).toFixed(1)) : null,
      failures: [...new Set(c.failures)],
    };
  }
  const valid = runs.filter((r) => r.status !== "invalid");
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const r of runs) for (const k of Object.keys(usage)) usage[k] += r.usage?.[k] ?? 0;
  return {
    cases: out,
    totals: {
      runs: runs.length,
      valid: valid.length,
      passed: valid.filter((r) => r.status === "pass").length,
      passRate: valid.length ? valid.filter((r) => r.status === "pass").length / valid.length : null,
      costUsd: runs.reduce((n, r) => n + r.costUsd, 0),
      durationMs: runs.reduce((n, r) => n + r.durationMs, 0),
      usage,
    },
  };
}

/** Which catalog tools no run called, and how often each was called. */
export function coverage(runs, toolNames) {
  const counts = Object.fromEntries(toolNames.map((n) => [n, 0]));
  for (const r of runs) for (const c of r.calls) if (c.tool in counts) counts[c.tool]++;
  return { counts, unused: toolNames.filter((n) => counts[n] === 0) };
}

/** A saved series entry from a summary — small, no transcripts. */
export function historyEntry(summary, meta) {
  const cases = {};
  for (const [id, c] of Object.entries(summary.cases)) {
    cases[id] = { passRate: c.passRate, meanCostUsd: round(c.meanCostUsd, 5), meanDurationMs: c.meanDurationMs, meanCalls: c.meanCalls };
  }
  return {
    ...meta,
    totals: {
      runs: summary.totals.runs,
      valid: summary.totals.valid,
      passRate: summary.totals.passRate,
      costUsd: round(summary.totals.costUsd, 4),
      durationMs: summary.totals.durationMs,
      usage: summary.totals.usage,
    },
    cases,
  };
}

/** What moved since the last saved entry for the same model: pass-rate
 *  changes of any size, cost changes past 20% — cost is noisy run to run. */
export function historyDelta(prev, next) {
  if (!prev) return [];
  const lines = [];
  for (const [id, c] of Object.entries(next.cases)) {
    const p = prev.cases?.[id];
    if (!p) {
      lines.push(`${id}: new`);
      continue;
    }
    if (p.passRate !== c.passRate) lines.push(`${id}: pass ${pct(p.passRate)} → ${pct(c.passRate)}`);
    if (p.meanCostUsd > 0 && Math.abs(c.meanCostUsd - p.meanCostUsd) / p.meanCostUsd > 0.2) {
      lines.push(`${id}: cost $${p.meanCostUsd.toFixed(4)} → $${c.meanCostUsd.toFixed(4)}`);
    }
  }
  const pt = prev.totals ?? {};
  if (pt.passRate !== next.totals.passRate) lines.push(`total: pass ${pct(pt.passRate)} → ${pct(next.totals.passRate)}`);
  if (pt.costUsd) lines.push(`total: cost $${pt.costUsd.toFixed(4)} → $${next.totals.costUsd.toFixed(4)}`);
  return lines;
}

export const pct = (r) => (r === null || r === undefined ? "n/a" : `${Math.round(r * 100)}%`);
const round = (x, d) => Number(x.toFixed(d));
