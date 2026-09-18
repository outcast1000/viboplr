// The pure half of the plugin-to-plugin call surface. The CallGraph is the
// part worth pinning hardest: a plain call stack would either miss A → B → A
// through an intermediate hop or falsely flag two independent concurrent
// calls into the same plugin, and the failure mode of getting it wrong is a
// silent 60s hang (the tool timeout) rather than an error.
import { describe, it, expect } from "vitest";
import { CallGraph, callableProblem, describePlugins } from "../utils/crossPluginCalls";
import type { PluginState } from "../types/plugin";

describe("CallGraph", () => {
  it("a direct self-call is a cycle", () => {
    expect(new CallGraph().wouldCycle("a", "a")).toBe(true);
  });

  it("detects A → B → A while A → B is in flight", () => {
    const g = new CallGraph();
    const leave = g.enter("a", "b");
    expect(g.wouldCycle("b", "a")).toBe(true);
    expect(g.describeCycle("b", "a")).toBe("b → a → b");
    leave();
    expect(g.wouldCycle("b", "a")).toBe(false);
  });

  it("detects a cycle through an intermediate hop (A → B → C → A)", () => {
    const g = new CallGraph();
    g.enter("a", "b");
    g.enter("b", "c");
    expect(g.wouldCycle("c", "a")).toBe(true);
    expect(g.describeCycle("c", "a")).toBe("c → a → b → c");
    // An unrelated fourth plugin calling into the chain is fine.
    expect(g.wouldCycle("d", "a")).toBe(false);
  });

  it("independent concurrent calls into the same target never collide", () => {
    const g = new CallGraph();
    g.enter("a", "ytdlp");
    g.enter("c", "ytdlp");
    expect(g.wouldCycle("ytdlp", "b")).toBe(false);
    expect(g.wouldCycle("b", "ytdlp")).toBe(false);
  });

  it("the same edge in flight twice stays until both leave", () => {
    const g = new CallGraph();
    const leave1 = g.enter("a", "b");
    const leave2 = g.enter("a", "b");
    leave1();
    expect(g.wouldCycle("b", "a")).toBe(true);
    leave2();
    expect(g.wouldCycle("b", "a")).toBe(false);
  });

  it("leave() is idempotent", () => {
    const g = new CallGraph();
    const leave = g.enter("a", "b");
    leave();
    leave();
    g.enter("a", "b"); // a second real call must still count
    expect(g.wouldCycle("b", "a")).toBe(true);
  });
});

const manifest = (name: string, extra: Record<string, unknown> = {}) =>
  ({ id: name, name, version: "1.0.0", description: `${name} desc`, ...extra }) as unknown as PluginState["manifest"];

const states: PluginState[] = [
  { id: "ytdlp", manifest: manifest("yt-dlp", { contributes: { downloadProviders: [{}], streamResolvers: [{}] } }), status: "active", enabled: true },
  { id: "lastfm", manifest: manifest("Last.fm", { contributes: { informationTypes: [{}, {}] } }), status: "active", enabled: false },
  { id: "broken", manifest: manifest("Broken"), status: "error", enabled: true, error: "boom" },
];

describe("callableProblem", () => {
  it("null for an enabled, active plugin", () => {
    expect(callableProblem(states, "ytdlp")).toBeNull();
  });
  it("names the reason: missing, disabled, not active", () => {
    expect(callableProblem(states, "nope")).toContain("not installed");
    expect(callableProblem(states, "lastfm")).toContain("disabled");
    expect(callableProblem(states, "broken")).toContain("status: error");
  });
});

describe("describePlugins", () => {
  it("merges live counts with declared capabilities and drops zeros", () => {
    const out = describePlugins(states, {
      searchProviders: [{ pluginId: "ytdlp" }],
      homeShelves: [],
      menuItems: [{ pluginId: "ytdlp" }, { pluginId: "ytdlp" }],
      assistantTools: [{ pluginId: "ytdlp" }, { pluginId: "lastfm" }],
    });
    const ytdlp = out.find((p) => p.id === "ytdlp")!;
    expect(ytdlp).toMatchObject({ name: "yt-dlp", version: "1.0.0", enabled: true, status: "active" });
    expect(ytdlp.capabilities).toEqual({
      searchProviders: 1, contextMenuItems: 2, assistantTools: 1, downloadProviders: 1, streamResolvers: 1,
    });
    const lastfm = out.find((p) => p.id === "lastfm")!;
    expect(lastfm.enabled).toBe(false);
    expect(lastfm.capabilities).toEqual({ assistantTools: 1, informationTypes: 2 });
    expect(out.find((p) => p.id === "broken")!.capabilities).toEqual({});
  });
});
