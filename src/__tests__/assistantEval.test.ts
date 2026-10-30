// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain .mjs script, no type declarations
import * as ev from "../../scripts/lib/assistantEval.mjs";
import { TOOLS } from "../../mcp/tools.mjs";

// The assistant eval's decisions (scripts/lib/assistantEval.mjs): what a
// `claude -p` stream says the model did, and whether that passes a case.
// The runner only launches and prints; a wrong grade here would make every
// eval run report plausible, wrong numbers.

const ROOT = join(__dirname, "..", "..");
const fixture = (name: string) =>
  readFileSync(join(ROOT, "tests", "assistant-eval", "fixtures", name), "utf8").split("\n");

interface Call {
  tool: string;
  args: Record<string, unknown>;
  isError?: boolean;
}

/** A merged run as mergeTurns builds it, with sensible defaults. */
function run(over: Partial<{ calls: Call[]; answer: string; mcpConnected: boolean; completed: boolean }> = {}) {
  return {
    mcpConnected: true,
    completed: true,
    calls: [] as Call[],
    answer: "",
    costUsd: 0.01,
    durationMs: 1000,
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    ...over,
  };
}

describe("parseStream (a real claude -p stream, trimmed)", () => {
  const turn = ev.parseStream(fixture("stream-tool-error.jsonl"));

  it("reads the model, the server connection and counts only MCP tools", () => {
    expect(turn.model).toBe("claude-haiku-5-5");
    expect(turn.mcpConnected).toBe(true);
    expect(turn.toolCount).toBe(3);
    expect(turn.hookEvents).toBe(2);
  });

  it("strips the server prefix and pairs each call with its result", () => {
    expect(turn.calls.map((c: Call) => c.tool)).toEqual(["app_version", "app_version"]);
    expect(turn.calls[0].args).toEqual({ checkLatest: true });
    expect(turn.calls.every((c: Call) => c.isError)).toBe(true);
    expect(turn.calls[0].result).toContain("No control API");
  });

  it("takes the final answer, cost and tokens from the result event", () => {
    expect(turn.answer).toMatch(/couldn't get the installed version/);
    expect(turn.result.costUsd).toBeCloseTo(0.0066964, 6);
    expect(turn.result.numTurns).toBe(3);
    expect(turn.result.usage).toEqual({ input: 6, output: 502, cacheRead: 57820, cacheWrite: 29333 });
    expect(turn.result.costBasis).toBe("list");
  });

  it("ignores lines that aren't JSON instead of failing the run", () => {
    const t = ev.parseStream(["not json", ...fixture("stream-tool-error.jsonl")]);
    expect(t.calls).toHaveLength(2);
  });

  it("reports a server that didn't connect", () => {
    const t = ev.parseStream([
      JSON.stringify({ type: "system", subtype: "init", model: "m", tools: [], mcp_servers: [{ name: "viboplr", status: "failed" }] }),
    ]);
    expect(t.mcpConnected).toBe(false);
  });
});

describe("mergeTurns", () => {
  it("sums cost, tokens and time over every turn and keeps the last answer", () => {
    const one = ev.parseStream(fixture("stream-tool-error.jsonl"));
    const merged = ev.mergeTurns([one, { ...one, answer: "second" }]);
    expect(merged.costUsd).toBeCloseTo(2 * 0.0066964, 6);
    expect(merged.usage.output).toBe(1004);
    expect(merged.calls).toHaveLength(4);
    expect(merged.answer).toBe("second");
    expect(merged.completed).toBe(true);
  });

  it("is incomplete when a turn has no result event", () => {
    const one = ev.parseStream(fixture("stream-tool-error.jsonl"));
    expect(ev.mergeTurns([one, { ...one, result: null }]).completed).toBe(false);
  });
});

describe("valueMatches / callMatches", () => {
  it("matches objects as subsets and arrays exactly", () => {
    expect(ev.valueMatches({ kind: "track" }, { kind: "track", likeState: 1 })).toBe(true);
    expect(ev.valueMatches({ kind: "album" }, { kind: "track" })).toBe(false);
    expect(ev.valueMatches([1, 2], [1, 2])).toBe(true);
    expect(ev.valueMatches([1, 2], [1, 2, 3])).toBe(false);
  });

  it("supports $absent, $present and case-insensitive $match", () => {
    expect(ev.valueMatches({ planHash: { $absent: true } }, { trackIds: [1] })).toBe(true);
    expect(ev.valueMatches({ planHash: { $absent: true } }, { planHash: "abc" })).toBe(false);
    expect(ev.valueMatches({ planHash: { $present: true } }, { planHash: "abc" })).toBe(true);
    expect(ev.valueMatches({ album: { $match: "rumours" } }, { album: "Rumours" })).toBe(true);
    expect(ev.valueMatches({ album: { $match: "rumours" } }, {})).toBe(false);
  });

  it("takes a bare tool name or a { tool, args } spec", () => {
    expect(ev.callMatches("browse", { tool: "browse", args: {} })).toBe(true);
    expect(ev.callMatches({ tool: "browse", args: { kind: "tags" } }, { tool: "browse", args: { kind: "tracks" } })).toBe(false);
  });
});

describe("checkValue / at", () => {
  const queue = { tracks: [{ title: "Airbag" }, { title: "Paranoid Android" }] };

  it("reads dotted paths, array indexes and lengths", () => {
    expect(ev.at(queue, "tracks.0.title")).toBe("Airbag");
    expect(ev.at(queue, "tracks.length")).toBe(2);
    expect(ev.at(queue, "missing.deep")).toBeUndefined();
  });

  it("applies each operator", () => {
    expect(ev.checkValue({ equals: "Airbag" }, "Airbag")).toBe(true);
    expect(ev.checkValue({ matches: "^air" }, "Airbag")).toBe(true);
    expect(ev.checkValue({ gte: 2 }, 2)).toBe(true);
    expect(ev.checkValue({ lte: 1 }, 2)).toBe(false);
    expect(ev.checkValue({ includes: "bag" }, "Airbag")).toBe(true);
    expect(ev.checkValue({ some: { title: "Paranoid Android" } }, queue.tracks)).toBe(true);
    expect(ev.checkValue({ some: { title: "Lucky" } }, queue.tracks)).toBe(false);
  });
});

describe("gradeCase", () => {
  const spec = {
    expect: {
      calls: ["browse", { tool: "play_tracks", args: { trackIds: { $present: true } } }],
      forbidden: ["delete_tracks"],
      maxCalls: 4,
      answer: { includes: ["OK Computer"], matches: "playing" },
      state: [{ get: "/queue", at: "tracks.0.title", equals: "Airbag" }],
    },
  };
  const good = run({
    calls: [
      { tool: "search_library", args: {} },
      { tool: "browse", args: { kind: "album_tracks", id: 4 } },
      { tool: "play_tracks", args: { trackIds: [1, 2] } },
    ],
    answer: "Now playing OK Computer.",
  });
  const state = [{ value: { tracks: [{ title: "Airbag" }] } }];

  it("passes a run that meets every expectation", () => {
    expect(ev.gradeCase(spec, good, state)).toEqual({ status: "pass", failures: [] });
  });

  it("requires the calls in order", () => {
    const swapped = run({ ...good, calls: [good.calls[2], good.calls[1]] });
    const g = ev.gradeCase(spec, swapped, state);
    expect(g.status).toBe("fail");
    expect(g.failures.join()).toMatch(/expected call play_tracks/);
  });

  it("names the arguments a near-miss call had", () => {
    const g = ev.gradeCase(spec, run({ ...good, calls: [good.calls[1], { tool: "play_tracks", args: { tracks: [] } }] }), state);
    expect(g.failures.join()).toMatch(/got \{"tracks":\[\]\}/);
  });

  it("fails a forbidden call, too many calls, a wrong answer and a wrong state", () => {
    const bad = run({
      calls: [...good.calls, { tool: "delete_tracks", args: { trackIds: [1] } }, { tool: "get_status", args: {} }],
      answer: "Done.",
    });
    const g = ev.gradeCase(spec, bad, [{ value: { tracks: [{ title: "Lucky" }] } }]);
    expect(g.status).toBe("fail");
    const text = g.failures.join("\n");
    expect(text).toMatch(/forbidden call delete_tracks/);
    expect(text).toMatch(/5 tool calls, more than 4/);
    expect(text).toMatch(/answer lacks "OK Computer"/);
    expect(text).toMatch(/doesn't match/);
    expect(text).toMatch(/got "Lucky"/);
  });

  it("reports a state read that failed", () => {
    expect(ev.gradeCase(spec, good, [{ error: "GET /queue → 503" }]).failures).toEqual(["state /queue: GET /queue → 503"]);
  });

  it("calls a run invalid, not failed, when the tools never worked", () => {
    expect(ev.gradeCase(spec, run({ mcpConnected: false }), state).status).toBe("invalid");
    expect(ev.gradeCase(spec, run({ completed: false }), state).status).toBe("invalid");
  });
});

describe("summarize / coverage / history", () => {
  const runs = [
    { case: "a", status: "pass", failures: [], calls: [{ tool: "browse" }], costUsd: 0.1, durationMs: 1000, usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
    { case: "a", status: "fail", failures: ["x"], calls: [{ tool: "browse" }, { tool: "play_tracks" }], costUsd: 0.3, durationMs: 3000, usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
    { case: "b", status: "invalid", failures: ["y"], calls: [], costUsd: 0.05, durationMs: 500, usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
  ];

  it("rates passes over valid runs but bills every run", () => {
    const s = ev.summarize(runs);
    expect(s.cases.a).toMatchObject({ runs: 2, valid: 2, passed: 1, passRate: 0.5, meanCalls: 1.5, failures: ["x"] });
    expect(s.cases.a.meanCostUsd).toBeCloseTo(0.2);
    expect(s.cases.b).toMatchObject({ valid: 0, passRate: null });
    expect(s.totals).toMatchObject({ runs: 3, valid: 2, passed: 1, passRate: 0.5 });
    expect(s.totals.costUsd).toBeCloseTo(0.45);
    expect(s.totals.usage).toEqual({ input: 3, output: 3, cacheRead: 3, cacheWrite: 3 });
  });

  it("lists the catalog tools no run called", () => {
    const cov = ev.coverage(runs, TOOLS.map((t) => t.name));
    expect(cov.counts.browse).toBe(2);
    expect(cov.unused).toContain("delete_tracks");
    expect(cov.unused).not.toContain("browse");
  });

  it("reports pass-rate moves and cost moves past 20%", () => {
    const prev = ev.historyEntry(ev.summarize(runs), { model: "m" });
    const nextRuns = runs.map((r) => (r.case === "a" ? { ...r, status: "pass", costUsd: r.costUsd * 2 } : r));
    const next = ev.historyEntry(ev.summarize(nextRuns), { model: "m" });
    const delta = ev.historyDelta(prev, next).join("\n");
    expect(delta).toMatch(/a: pass 50% → 100%/);
    expect(delta).toMatch(/a: cost \$0\.2000 → \$0\.4000/);
    expect(ev.historyDelta(null, next)).toEqual([]);
  });
});

describe("cases.json", () => {
  const { cases } = JSON.parse(readFileSync(join(ROOT, "tests", "assistant-eval", "cases.json"), "utf8"));
  const names = new Set(TOOLS.map((t) => t.name));
  const toolOf = (s: string | { tool: string }) => (typeof s === "string" ? s : s.tool);

  it("has unique ids and names only real tools", () => {
    expect(new Set(cases.map((c: { id: string }) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      for (const s of [...(c.expect?.calls ?? []), ...(c.expect?.forbidden ?? [])]) {
        expect(names.has(toolOf(s)), `${c.id}: unknown tool ${toolOf(s)}`).toBe(true);
      }
    }
  });

  it("gives every state check a source and exactly one operator", () => {
    const ops = ["equals", "matches", "gte", "lte", "includes", "some"];
    for (const c of cases) {
      for (const s of c.expect?.state ?? []) {
        expect(Boolean(s.get) !== Boolean(s.sql), `${c.id}: state needs get or sql`).toBe(true);
        expect(ops.filter((o) => o in s), `${c.id}: one operator per check`).toHaveLength(1);
      }
    }
  });
});
