// Host operations shared by the two callers that stand outside the UI: the
// localhost control API (hooks/useControlApi.ts) and a plugin calling another
// plugin (usePlugins.buildAPI). Each operation is implemented ONCE here; the
// callers are thin adapters that own only what genuinely differs between them:
//
//   - argument extraction + "field is required" hints (a URL/verb name for an
//     HTTP caller, a method name for a plugin),
//   - the response shape (the control API projects slim rows and mints
//     searchIds for a remote model; a plugin gets the raw result),
//   - the plugin-only call wrapper (`via` — usePlugins' crossCall: cycle
//     guard + attribution log line).
//
// Everything that decides WHETHER a call may run and WHAT it runs lives here,
// so the two callers cannot drift. They did before this module existed: the
// control API's assistant.invoke checked only `enabled` while the plugin path
// also rejected a plugin that failed to activate, so an HTTP caller waited out
// the 60s handler timeout where a plugin got a clear error.
//
// Errors are thrown as plain `Error`s with a message a model can act on; the
// control API bridge turns any rejection into a 400 body, a plugin sees the
// rejection verbatim. A *provider* failure (search `{ status: "error" }`) is
// a result, never a throw — adapters decide how to surface it.

import type {
  PluginAssistantTool, PluginSearchProvider, PluginSearchResult, PluginState,
} from "../types/plugin";
import { buildAssistantRoster, resolveSearchProvider } from "./controlApi";
import { callableProblem } from "./crossPluginCalls";

/** Wraps the actual handler invocation. The control API calls straight
 *  through; a plugin caller passes crossCall(target, what, run). */
export type OpVia = <T>(target: string, what: string, run: () => Promise<T>) => Promise<T>;

const direct: OpVia = (_target, _what, run) => run();

type PluginStates = Array<Pick<PluginState, "id" | "enabled" | "status">>;

// --- Catalog search ---

export interface SearchOpsRegistry {
  pluginStates: PluginStates;
  /** The user-visibility-filtered list — never the raw registrations. */
  searchProviders: PluginSearchProvider[];
  invokePluginSearch: (pluginId: string, providerId: string, query: string, limit: number) => Promise<PluginSearchResult>;
}

export interface SearchProviderListing {
  key: string;
  pluginId: string;
  providerId: string;
  name: string;
}

export function listSearchProviders(reg: Pick<SearchOpsRegistry, "searchProviders">): SearchProviderListing[] {
  return reg.searchProviders.map((p) => ({
    key: `${p.pluginId}:${p.providerId}`,
    pluginId: p.pluginId,
    providerId: p.providerId,
    name: p.name,
  }));
}

export const SEARCH_LIMIT_DEFAULT = 30;
export const SEARCH_LIMIT_MAX = 100;

/** Integer in [1, 100]; anything that isn't a finite number is the default. */
export function clampSearchLimit(limit: unknown): number {
  return typeof limit === "number" && Number.isFinite(limit)
    ? Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(limit)))
    : SEARCH_LIMIT_DEFAULT;
}

/**
 * Run one catalog search. `providerKey` accepts the full `plugin:provider`
 * key or an unambiguous short form (see resolveSearchProvider). Resolves with
 * the provider which answered (callers echo its key / name) and the raw result.
 */
export async function searchCatalog(
  reg: SearchOpsRegistry,
  args: { providerKey: string; query: string; limit?: unknown },
  via: OpVia = direct,
): Promise<{ provider: PluginSearchProvider; result: PluginSearchResult }> {
  const provider = resolveSearchProvider(reg.searchProviders, args.providerKey);
  if (typeof provider === "string") throw new Error(provider);
  const problem = callableProblem(reg.pluginStates, provider.pluginId);
  if (problem) throw new Error(problem);
  const limit = clampSearchLimit(args.limit);
  const result = await via(provider.pluginId, `search:${provider.providerId}`, () =>
    reg.invokePluginSearch(provider.pluginId, provider.providerId, args.query, limit),
  );
  return { provider, result };
}

// --- Assistant tools (plugin-to-plugin RPC / the control API's plugin_tools) ---

export interface AssistantOpsRegistry {
  pluginStates: PluginStates;
  assistantTools: PluginAssistantTool[];
  assistantInstructions: Map<string, string>;
  pluginNames?: Map<string, string>;
  invokeAssistantTool: (pluginId: string, name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export function listAssistantTools(
  reg: Omit<AssistantOpsRegistry, "pluginStates" | "invokeAssistantTool">,
  pluginId?: string,
): ReturnType<typeof buildAssistantRoster> {
  const roster = buildAssistantRoster(reg.assistantTools, reg.assistantInstructions, reg.pluginNames ?? new Map());
  return pluginId ? roster.filter((p) => p.pluginId === pluginId) : roster;
}

/**
 * Invoke one plugin's assistant tool and resolve with its return value.
 * Checks, in order: the plugin is callable (installed → enabled → active),
 * then the tool is registered — so "not installed" beats "no such tool", and
 * the no-such-tool rejection lists what the plugin does register. Handler
 * throws and the 60s timeout propagate as rejections.
 */
export async function invokeAssistantTool(
  reg: AssistantOpsRegistry,
  args: { pluginId: string; tool: string; args?: unknown },
  via: OpVia = direct,
): Promise<unknown> {
  const { pluginId, tool } = args;
  const problem = callableProblem(reg.pluginStates, pluginId);
  if (problem) throw new Error(problem);
  if (!reg.assistantTools.some((t) => t.pluginId === pluginId && t.name === tool)) {
    const names = reg.assistantTools.filter((t) => t.pluginId === pluginId).map((t) => t.name).join(", ");
    throw new Error(`plugin "${pluginId}" registers no tool "${tool}" (its tools: ${names || "none"})`);
  }
  const toolArgs =
    typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
      ? (args.args as Record<string, unknown>)
      : {};
  return via(pluginId, `tool:${tool}`, () => reg.invokeAssistantTool(pluginId, tool, toolArgs));
}
