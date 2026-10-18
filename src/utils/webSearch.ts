// Web search as a shared service (`api.webSearch`, `POST /v1/web/search`):
// the pure parts — cleaning a provider's answer, the user's provider order,
// and the walk that asks providers in that order. hostOps.webSearch is the one
// operation both callers (a plugin, the control API) run; this module holds
// what it decides with, so it can be tested without a registry.

import type {
  PluginWebSearchAnswer, PluginWebSearchHit, PluginWebSearchProvider, PluginWebSearchResult,
} from "../types/plugin";

/** One walk over the user's providers, all of them together. Kept under the
 *  control API's slow bridge timeout (`bridge_timeout × 7` = 70s in
 *  control_api.rs) so a walk always answers before the HTTP caller gives up. */
export const WEB_SEARCH_WALK_BUDGET_MS = 60_000;
export const WEB_SEARCH_LIMIT_DEFAULT = 10;
export const WEB_SEARCH_LIMIT_MAX = 25;
/** An engine's excerpt is a couple of lines; anything longer is a provider
 *  handing over page text, which a caller fetches itself if it wants it. */
const MAX_SNIPPET_CHARS = 400;
const MAX_TITLE_CHARS = 200;

/** Store key for the user's order + on/off, `[{ id: "pluginId:providerId", enabled }]`
 *  — the same shape as `streamResolverOrder`. */
export const WEB_SEARCH_ORDER_KEY = "webSearchOrder";

export interface WebSearchOrderEntry {
  id: string;
  enabled: boolean;
}

export type OrderedWebSearchProvider = PluginWebSearchProvider & { key: string; enabled: boolean };

/** Integer in [1, 25]; anything that isn't a finite number is the default. */
export function clampWebSearchLimit(limit: unknown): number {
  return typeof limit === "number" && Number.isFinite(limit)
    ? Math.min(WEB_SEARCH_LIMIT_MAX, Math.max(1, Math.floor(limit)))
    : WEB_SEARCH_LIMIT_DEFAULT;
}

export const webSearchProviderKey = (p: Pick<PluginWebSearchProvider, "pluginId" | "providerId">): string =>
  `${p.pluginId}:${p.providerId}`;

/**
 * The registered providers in the user's order, each with its switch. A
 * provider the stored order doesn't name (newly installed) goes last and on —
 * the same rule as the playback-fallback list, so installing a web-search
 * plugin is enough to use it. Stored entries for providers that aren't
 * registered right now are skipped, not dropped: the order is only rewritten
 * when the user changes it, so a plugin disabled for a while comes back where
 * it was.
 */
export function orderWebSearchProviders(
  providers: PluginWebSearchProvider[],
  stored: WebSearchOrderEntry[] | null | undefined,
): OrderedWebSearchProvider[] {
  const byKey = new Map(providers.map((p) => [webSearchProviderKey(p), p]));
  const out: OrderedWebSearchProvider[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(stored) ? stored : []) {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) continue;
    const p = byKey.get(entry.id);
    if (!p) continue;
    seen.add(entry.id);
    out.push({ ...p, key: entry.id, enabled: entry.enabled !== false });
  }
  for (const [key, p] of byKey) {
    if (!seen.has(key)) out.push({ ...p, key, enabled: true });
  }
  return out;
}

/**
 * Write back an order after the user moved or switched a row. Entries for
 * providers not on screen (their plugin is off) are kept after the visible
 * ones, so a reorder today doesn't forget where an absent provider sat.
 */
export function mergeWebSearchOrder(
  shown: Array<Pick<OrderedWebSearchProvider, "key" | "enabled">>,
  stored: WebSearchOrderEntry[] | null | undefined,
): WebSearchOrderEntry[] {
  const shownKeys = new Set(shown.map((p) => p.key));
  const rest = (Array.isArray(stored) ? stored : []).filter(
    (e) => e && typeof e.id === "string" && !shownKeys.has(e.id),
  );
  return [...shown.map((p) => ({ id: p.key, enabled: p.enabled })), ...rest];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Not an error: an unparseable URL just has no host to show. Callers only
    // reach this with an http(s) URL that passed the scheme check.
    return "";
  }
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Make a provider's answer safe to hand on, once, where the host receives it:
 * keep only http(s) links with a title, collapse whitespace, cap lengths, drop
 * repeats of the same URL, fill `site` from the URL, trim to `limit`. A
 * provider is plugin code, and its results go straight to other plugins and
 * to a model — a `javascript:` link or a page of text in a snippet must not
 * pass. `ok` with nothing usable left is a miss.
 */
export function normalizeWebSearchResult(raw: unknown, limit: number): PluginWebSearchResult {
  if (!raw || typeof raw !== "object") return { status: "empty" };
  const r = raw as { status?: unknown; message?: unknown; results?: unknown };
  if (r.status === "error") {
    const message = typeof r.message === "string" && r.message.trim() ? clip(r.message, 300) : undefined;
    return { status: "error", message };
  }
  if (r.status !== "ok" || !Array.isArray(r.results)) return { status: "empty" };

  const seen = new Set<string>();
  const results: PluginWebSearchHit[] = [];
  for (const item of r.results) {
    if (results.length >= limit) break;
    if (!item || typeof item !== "object") continue;
    const { title, url, snippet, site } = item as Record<string, unknown>;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) continue;
    if (typeof title !== "string" || !title.trim()) continue;
    const cleanUrl = url.trim();
    if (seen.has(cleanUrl)) continue;
    seen.add(cleanUrl);
    const hit: PluginWebSearchHit = { title: clip(title, MAX_TITLE_CHARS), url: cleanUrl };
    if (typeof snippet === "string" && snippet.trim()) hit.snippet = clip(snippet, MAX_SNIPPET_CHARS);
    const host = typeof site === "string" && site.trim() ? clip(site, 100) : hostOf(cleanUrl);
    if (host) hit.site = host;
    results.push(hit);
  }
  return results.length ? { status: "ok", results } : { status: "empty" };
}

/**
 * Ask providers in order until one answers. `ok` and `empty` both end the
 * walk — "nothing on the web" from a working engine is an answer, and asking
 * the next one would only spend time to say the same. An `error` moves on;
 * if every provider errors the answer is an error naming each failure, so
 * the user (or model) sees *why* rather than a bare "no results".
 *
 * The whole walk shares one `budgetMs`: each provider gets what is left, and
 * providers the walk never reached are listed as not asked. Without it a
 * walk over several hung engines (20s each) outlasted the control API's
 * bridge, and the caller got a bare timeout instead of this error.
 */
export async function walkWebSearchProviders<P extends Pick<OrderedWebSearchProvider, "key" | "name">>(
  providers: P[],
  ask: (provider: P) => Promise<PluginWebSearchResult>,
  opts: { budgetMs?: number; now?: () => number } = {},
): Promise<PluginWebSearchAnswer> {
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? WEB_SEARCH_WALK_BUDGET_MS;
  const deadline = now() + budget;
  const failures: string[] = [];
  for (const p of providers) {
    const left = deadline - now();
    if (left <= 0) {
      failures.push(`${p.name}: not asked (the search ran out of time)`);
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      ask(p),
      new Promise<PluginWebSearchResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: "error", message: "timed out" }), left);
      }),
    ]).finally(() => clearTimeout(timer));
    if (result.status !== "error") return { ...result, provider: p.key, providerName: p.name };
    failures.push(`${p.name}: ${result.message ?? "failed"}`);
  }
  return { status: "error", message: failures.join("; ") || "no web search provider answered" };
}
