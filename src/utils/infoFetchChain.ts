// The core of "get this info type for this entity through the plugin provider
// chain" — extracted from useInformationTypes so the detail pages and the
// control API's info.fetch run the SAME walk (priority order, first ok wins),
// persist through the same cache write, and can't drift. The hook keeps the
// UI concerns (sections state, progress rendering, empty-delay); this module
// owns the decision + the walk + the cache writes.
import { invoke } from "@tauri-apps/api/core";
import type { InfoEntity, InfoFetchResult, FetchProgressEntry } from "../types/informationTypes";

export const ERROR_TTL = 3600; // 1 hour in seconds

/** How long a cache row that depends on the user's own disk stays fresh. */
export const LOCAL_INFO_TTL = 86400; // 1 day in seconds

/** The built-in local-lyrics provider row (seeded by DB migration #13; the
 *  frontend answers it in usePlugins.invokeInfoFetch via `get_local_lyrics`).
 *  Mirrors the image chain's `core:` rows — the prefix can never collide with
 *  a plugin id, since `:` isn't legal in a manifest id. */
export const CORE_LOCAL_LYRICS_PROVIDER = "core:local-lyrics";

/**
 * Effective TTL for ONE cached info row. The type's TTL (90 days for lyrics)
 * is right for a web answer, but once a type has a `core:` local provider the
 * answer can change on the user's own disk, so two kinds of row must expire
 * daily instead:
 *
 * - a row the LOCAL provider produced (the .lrc may have been edited), and
 * - any non-ok row (a chain-wide "no lyrics found" must not mask an .lrc the
 *   user adds tomorrow — with the old 90-day miss, a track whose lyrics were
 *   looked up once before the file existed stayed lyric-less for 3 months).
 *
 * Ok rows from web providers — including a user's manual edit, which is
 * saved under the web row — keep the type TTL, so lrclib isn't re-asked
 * daily and an edit isn't clobbered after a day.
 */
export function cacheTtlForRow(
  providers: Array<[string, number]>,
  integerId: number,
  status: string | null,
  typeTtl: number,
): number {
  const hasCore = providers.some(([pluginId]) => pluginId.startsWith("core:"));
  if (!hasCore) return typeTtl;
  const rowIsCore = providers.some(
    ([pluginId, id]) => id === integerId && pluginId.startsWith("core:"),
  );
  if (rowIsCore || status !== "ok") return Math.min(typeTtl, LOCAL_INFO_TTL);
  return typeTtl;
}

export type CacheAction = "render" | "render_and_refetch" | "loading" | "empty";

/** What to do with a cached info value: render it, render-but-refresh (stale
 *  ok), fetch (no usable cache), or show nothing (fresh not_found/error). */
export function decideCacheAction(
  status: string | null,
  fetchedAt: number | null,
  ttl: number,
  now: number,
): CacheAction {
  if (status === null || fetchedAt === null) return "loading";
  const age = now - fetchedAt;
  const effectiveTtl = status === "error" ? ERROR_TTL : ttl;
  const stale = age >= effectiveTtl;

  if (status === "ok") return stale ? "render_and_refetch" : "render";
  // not_found or error
  return stale ? "loading" : "empty";
}

export type InvokeInfoFetch = (
  pluginId: string,
  infoTypeId: string,
  entity: InfoEntity,
  onFetchUrl?: (url: string) => void,
) => Promise<InfoFetchResult>;

export interface FetchChainOpts {
  typeId: string;
  /** The type's provider chain in priority order: [pluginId, integerId]. */
  providers: Array<[string, number]>;
  entity: InfoEntity;
  entityKey: string;
  invokeInfoFetch: InvokeInfoFetch;
  /** pluginId → display name for progress entries; falls back to the id. */
  pluginNames?: Map<string, string>;
  /** Called with the running step list after every change (same array,
   *  mutated) — the hook renders it; headless callers omit it. */
  onProgress?: (steps: FetchProgressEntry[]) => void;
}

/** Walk the provider chain (first ok wins), persist the outcome into the
 *  shared cache (`info_upsert_value`) and drop other providers' stale rows.
 *  Never throws — a thrown provider is recorded as an error status, exactly
 *  as the detail pages have always behaved. */
export async function fetchInfoThroughChain(
  opts: FetchChainOpts,
): Promise<{ result: InfoFetchResult; usedIntegerId: number }> {
  const { typeId, providers, entity, entityKey, invokeInfoFetch, pluginNames, onProgress } = opts;
  let usedIntegerId = providers[0]?.[1] ?? 0;
  const steps: FetchProgressEntry[] = [];
  try {
    let result: InfoFetchResult = { status: "error" };

    for (const [pluginId, integerId] of providers) {
      const step: FetchProgressEntry = {
        provider: pluginNames?.get(pluginId) ?? pluginId,
        status: "fetching",
      };
      steps.push(step);
      onProgress?.(steps);

      result = await invokeInfoFetch(pluginId, typeId, entity, (url) => {
        step.url = url;
        onProgress?.(steps);
      });
      usedIntegerId = integerId;
      step.status = result.status === "ok" ? "ok" : result.status === "not_found" ? "not_found" : "error";
      onProgress?.(steps);
      if (result.status === "ok") break;
    }

    await invoke("info_upsert_value", {
      informationTypeId: usedIntegerId,
      entityKey,
      value: result.status === "ok" ? JSON.stringify(result.value) : "{}",
      status: result.status,
    });

    // Clean up stale cached values from other providers for this type_id
    for (const [, integerId] of providers) {
      if (integerId !== usedIntegerId) {
        await invoke("info_delete_value", {
          informationTypeId: integerId,
          entityKey,
        }).catch(() => {}); // eslint-disable-line no-restricted-syntax -- Fire-and-forget: dropping a stale cache row; the fetched value above is the real work
      }
    }

    return { result, usedIntegerId };
  } catch (e) {
    console.error(`Info fetch chain for "${typeId}" (${entityKey}) failed:`, e);
    await invoke("info_upsert_value", {
      informationTypeId: usedIntegerId,
      entityKey,
      value: "{}",
      status: "error",
    }).catch(() => {}); // eslint-disable-line no-restricted-syntax -- Fire-and-forget: recording an error status; the error is already logged above
    return { result: { status: "error" }, usedIntegerId };
  }
}
