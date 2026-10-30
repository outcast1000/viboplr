// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS, runTool, type CatalogTool, type ToolContext } from "../../mcp/tools.mjs";

// The assistant tool contract, TypeScript half. tests/mcp/scenarios.json says,
// for every tool, which HTTP request a call sends and which bridge verb the
// Rust route hands the webview. This file checks the first and that the
// webview handles the second; control_api.rs `test_mcp_contract_scenarios`
// sends the same requests through the real router. Together they catch a tool
// pointing at a renamed route, a route bridging a verb useControlApi.ts doesn't
// know (a 10s timeout, live only), and a tool or action added with no test.

interface ExpectedRequest {
  method: string;
  path: string;
  body?: unknown;
  raw?: boolean;
}

interface Scenario {
  tool: string;
  args: Record<string, unknown>;
  requests?: ExpectedRequest[];
  verb?: string;
  throws?: string;
  file?: string;
}

const ROOT = join(__dirname, "..", "..");
const { scenarios } = JSON.parse(readFileSync(join(ROOT, "tests", "mcp", "scenarios.json"), "utf8")) as {
  scenarios: Scenario[];
};

/** Tools whose `action` is handed through unbranched — each value is validated
 *  by the app (uiControl.ts, pinned by uiControl.test.ts), so one scenario per
 *  route stands for all of them. */
const PASSTHROUGH_ACTIONS = new Set(["ui_control"]);

const label = (s: Scenario) => `${s.tool} ${JSON.stringify(s.args)}`;

/** A ctx that records every request and answers each with a harmless value. */
function recordingCtx(scenario: Scenario) {
  const sent: ExpectedRequest[] = [];
  const ctx: ToolContext = {
    request: async (method, path, body, opts) => {
      const req: ExpectedRequest = { method, path };
      // JSON round-trip: what goes on the wire (undefined fields vanish).
      if (body !== undefined) req.body = JSON.parse(JSON.stringify(body));
      if (opts?.raw) req.raw = true;
      sent.push(req);
      return opts?.raw ? { base64: "", mimeType: "image/png" } : { version: "1.0.0", profile: "default" };
    },
    launchApp: async () => ({ launched: true }),
    fetchLatestRelease: async () => ({ version: "1.0.0", url: "https://example.invalid", publishedAt: "" }),
    readTextFile: async () => scenario.file ?? "[]",
    mcpVersion: "test",
  };
  return { ctx, sent };
}

function enumValues(tool: CatalogTool, prop: string): string[] | null {
  const schema = (tool.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.[prop];
  return schema?.enum ?? null;
}

describe("MCP contract: scenario table", () => {
  it("names only real tools and gives each scenario one outcome", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const s of scenarios) {
      expect(names.has(s.tool), `unknown tool in scenarios.json: ${s.tool}`).toBe(true);
      expect((s.requests === undefined) !== (s.throws === undefined), `${label(s)}: needs exactly one of requests / throws`).toBe(true);
      if (s.throws) expect(s.verb, `${label(s)}: a refused call bridges nothing`).toBeUndefined();
    }
  });

  it("covers every tool", () => {
    const covered = new Set(scenarios.filter((s) => s.requests).map((s) => s.tool));
    const missing = TOOLS.map((t) => t.name).filter((n) => !covered.has(n));
    expect(missing, "add a scenario to tests/mcp/scenarios.json for each new tool").toEqual([]);
  });

  it("covers every action of every tool, and every browse kind", () => {
    const missing: string[] = [];
    const check = (tool: CatalogTool, prop: string) => {
      const values = enumValues(tool, prop);
      if (!values) return;
      const seen = new Set(scenarios.filter((s) => s.tool === tool.name && s.requests).map((s) => s.args[prop]));
      for (const v of values) if (!seen.has(v)) missing.push(`${tool.name} ${prop}=${v}`);
    };
    for (const tool of TOOLS) {
      if (!PASSTHROUGH_ACTIONS.has(tool.name)) check(tool, "action");
    }
    check(TOOLS.find((t) => t.name === "browse")!, "kind");
    expect(missing, "add a scenario to tests/mcp/scenarios.json for each").toEqual([]);
  });
});

describe("MCP contract: each call sends exactly its request", () => {
  for (const s of scenarios) {
    it(label(s), async () => {
      const tool = TOOLS.find((t) => t.name === s.tool)!;
      const { ctx, sent } = recordingCtx(s);
      if (s.throws) {
        await expect(runTool(tool, s.args, ctx)).rejects.toThrow(s.throws);
        expect(sent).toEqual([]);
        return;
      }
      await runTool(tool, s.args, ctx);
      expect(sent).toEqual(s.requests);
    });
  }
});

describe("MCP contract: the webview handles every verb a tool reaches", () => {
  const source = readFileSync(join(ROOT, "src", "hooks", "useControlApi.ts"), "utf8");
  const dispatch = source.slice(source.indexOf("async function dispatch("));
  const handled = new Set([...dispatch.matchAll(/^\s*case "([^"]+)":/gm)].map((m) => m[1]));
  const declared = new Set(scenarios.map((s) => s.verb).filter((v): v is string => !!v));

  it("has a useControlApi dispatch case for each declared verb", () => {
    expect(handled.size, "dispatch() not found in useControlApi.ts — update this test").toBeGreaterThan(20);
    const unhandled = [...declared].filter((v) => !handled.has(v));
    expect(unhandled, "verbs Rust bridges that useControlApi.ts answers with 'unknown verb'").toEqual([]);
  });

  it("reaches every verb the dispatcher handles", () => {
    // Bridged only by a second call carrying the hash the first one returned,
    // so no fixed scenario can reach it; control_api.rs
    // test_tracks_delete_is_two_phase_and_bridges_the_plan pins that bridge.
    const reachedElsewhere = new Set(["tracks.delete"]);
    const unreached = [...handled].filter((v) => !declared.has(v) && !reachedElsewhere.has(v));
    expect(unreached, "a dispatch case no scenario reaches — add the scenario, or a dead case to delete").toEqual([]);
  });
});
