// Pure pieces of the plugin-to-plugin call surface (`api.search.query`,
// `api.assistant.invoke`, `api.plugins.list`).
//
// The mechanism is deliberately NOT a new registry or bus: every plugin
// surface is already a registry of named handlers keyed `pluginId:name` that
// the host (and the control API) invoke — these calls just let a plugin stand
// where the control API stands. What this module adds is the part the control
// API never needed: a caller that is itself a plugin, so a call can loop back
// into the caller (A → B → A) and spin until the 60s timeout, and the user
// should be able to see which plugin caused which other plugin's activity.

import type { PluginState, PluginManifestContributes, PluginDescriptor } from "../types/plugin";
import { summarizeCapabilities, type LiveCapabilityCounts } from "./controlApi";

/**
 * In-flight cross-plugin call edges, for cycle detection.
 *
 * Each `enter(caller, target)` records that `caller` is currently waiting on
 * `target`. A new call is a cycle when `target` is already (transitively)
 * waiting on `caller` — i.e. following in-flight edges from `target` reaches
 * `caller`. Edges are counted, not booleaned, because the same pair can be in
 * flight more than once (two concurrent searches). Independent concurrent
 * calls (A → B while C → B) never collide, which a plain stack would get wrong.
 */
export class CallGraph {
  private edges = new Map<string, Map<string, number>>();

  /** Would `caller → target` close a loop with what is in flight right now? */
  wouldCycle(caller: string, target: string): boolean {
    if (caller === target) return true;
    const seen = new Set<string>();
    const stack = [target];
    while (stack.length) {
      const node = stack.pop()!;
      if (node === caller) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const next of this.edges.get(node)?.keys() ?? []) stack.push(next);
    }
    return false;
  }

  /** Record an in-flight call; returns the matching leave() to run in finally. */
  enter(caller: string, target: string): () => void {
    let out = this.edges.get(caller);
    if (!out) {
      out = new Map();
      this.edges.set(caller, out);
    }
    out.set(target, (out.get(target) ?? 0) + 1);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      const o = this.edges.get(caller);
      if (!o) return;
      const n = (o.get(target) ?? 0) - 1;
      if (n <= 0) o.delete(target);
      else o.set(target, n);
      if (o.size === 0) this.edges.delete(caller);
    };
  }

  /** Human-readable path for the error message: caller → … → caller. */
  describeCycle(caller: string, target: string): string {
    // Walk from target back to caller along in-flight edges (first path found).
    const path = this.findPath(target, caller) ?? [target, caller];
    return [caller, ...path].join(" → ");
  }

  private findPath(from: string, to: string): string[] | null {
    const prev = new Map<string, string>();
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) {
      const node = queue.shift()!;
      if (node === to) {
        const path = [node];
        let cur = node;
        while (prev.has(cur)) {
          cur = prev.get(cur)!;
          path.unshift(cur);
        }
        return path;
      }
      for (const next of this.edges.get(node)?.keys() ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        prev.set(next, node);
        queue.push(next);
      }
    }
    return null;
  }
}

export interface LiveCapabilitySources {
  searchProviders: Array<{ pluginId: string }>;
  homeShelves: Array<{ pluginId: string }>;
  menuItems: Array<{ pluginId: string }>;
  assistantTools: Array<{ pluginId: string }>;
}

export function describePlugins(
  states: Array<Pick<PluginState, "id" | "manifest" | "enabled" | "status">>,
  live: LiveCapabilitySources,
): PluginDescriptor[] {
  const count = (list: Array<{ pluginId: string }>, id: string) =>
    list.filter((x) => x.pluginId === id).length;
  return states.map((p) => {
    const counts: LiveCapabilityCounts = {
      searchProviders: count(live.searchProviders, p.id),
      homeShelves: count(live.homeShelves, p.id),
      contextMenuItems: count(live.menuItems, p.id),
      assistantTools: count(live.assistantTools, p.id),
    };
    const contributes: PluginManifestContributes | undefined = p.manifest?.contributes;
    return {
      id: p.id,
      name: p.manifest?.name ?? p.id,
      version: p.manifest?.version ?? null,
      description: p.manifest?.description ?? null,
      enabled: p.enabled,
      status: p.status,
      capabilities: summarizeCapabilities(contributes, counts),
    };
  });
}

/** The "is this plugin callable" check shared by search.query and
 *  assistant.invoke. Returns an error message, or null when callable. */
export function callableProblem(
  states: Array<Pick<PluginState, "id" | "enabled" | "status">>,
  pluginId: string,
): string | null {
  const p = states.find((s) => s.id === pluginId);
  if (!p) return `plugin "${pluginId}" is not installed`;
  if (!p.enabled) return `plugin "${pluginId}" is disabled`;
  if (p.status !== "active") return `plugin "${pluginId}" is not active (status: ${p.status})`;
  return null;
}
