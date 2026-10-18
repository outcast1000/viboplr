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
  PluginWebSearchAnswer, PluginWebSearchResult,
} from "../types/plugin";
import { buildAssistantRoster, resolveSearchProvider } from "./controlApi";
import { callableProblem } from "./crossPluginCalls";
import { clampWebSearchLimit, walkWebSearchProviders, type OrderedWebSearchProvider } from "./webSearch";

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

// --- Web search ---

export interface WebSearchOpsRegistry {
  pluginStates: PluginStates;
  /** Every registered provider in the user's order, each with its switch. */
  webSearchProviders: OrderedWebSearchProvider[];
  /** Runs one provider's handler; never rejects (timeouts and throws come
   *  back as `{ status: "error" }`), and the result is already normalized. */
  invokeWebSearch: (pluginId: string, providerId: string, query: string, limit: number) => Promise<PluginWebSearchResult>;
}

/** The providers a caller may use: switched on, in the user's order. */
export function listWebSearchProviders(reg: Pick<WebSearchOpsRegistry, "webSearchProviders">): SearchProviderListing[] {
  return reg.webSearchProviders.filter((p) => p.enabled).map((p) => ({
    key: p.key,
    pluginId: p.pluginId,
    providerId: p.providerId,
    name: p.name,
  }));
}

/**
 * Run a web search. No `provider`: walk the user's switched-on providers in
 * order, skipping any whose plugin isn't callable right now, first answer
 * wins (see walkWebSearchProviders). With `provider`: that one only — and a
 * provider the user switched off is refused, not quietly run, because the
 * switch is the user saying "don't send my searches there".
 */
export async function webSearch(
  reg: WebSearchOpsRegistry,
  args: { query: string; limit?: unknown; provider?: string },
  via: OpVia = direct,
): Promise<PluginWebSearchAnswer> {
  const query = args.query.trim();
  if (!query) throw new Error("query is required");
  const limit = clampWebSearchLimit(args.limit);
  const run = (p: OrderedWebSearchProvider) =>
    via(p.pluginId, `websearch:${p.providerId}`, () => reg.invokeWebSearch(p.pluginId, p.providerId, query, limit));

  if (args.provider) {
    // Resolved among the switched-on providers only, so neither the
    // ambiguity check nor the roster in an error names an engine the user
    // turned off. Only a name that points at one of those gets told so.
    const enabled = reg.webSearchProviders.filter((p) => p.enabled);
    const provider = resolveSearchProvider(enabled, args.provider, "web search provider");
    if (typeof provider === "string") {
      const off = resolveSearchProvider(reg.webSearchProviders, args.provider);
      if (typeof off !== "string" && !off.enabled) {
        throw new Error(`web search provider "${off.name}" is switched off in Settings → Providers → Web search`);
      }
      throw new Error(provider);
    }
    const problem = callableProblem(reg.pluginStates, provider.pluginId);
    if (problem) throw new Error(problem);
    const result = await run(provider);
    return { ...result, provider: provider.key, providerName: provider.name };
  }

  const usable = reg.webSearchProviders.filter(
    (p) => p.enabled && !callableProblem(reg.pluginStates, p.pluginId),
  );
  if (!usable.length) {
    throw new Error(
      reg.webSearchProviders.length
        ? "every web search provider is switched off or not running (Settings → Providers → Web search)"
        : "no web search provider is installed — plugins in the extension gallery that provide one list \"web-search\" in `provides`",
    );
  }
  // A refusal from `via` (a call cycle — the caller is itself a provider
  // somewhere upstream) only rules out that provider; the walk moves on.
  return walkWebSearchProviders(usable, (p) =>
    run(p).catch((e: unknown) => ({
      status: "error" as const,
      message: e instanceof Error ? e.message : String(e),
    })),
  );
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
