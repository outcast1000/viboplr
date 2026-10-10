// The core of "get this info type for this entity through the plugin provider
// chain" — extracted from useInformationTypes so the detail pages and the
// control API's info.fetch run the SAME walk (priority order, first ok wins),
// persist through the same cache write, and can't drift. The hook keeps the
// UI concerns (sections state, progress rendering, empty-delay); this module
// owns the decision + the walk + the cache writes.
import { invoke } from "@tauri-apps/api/core";
import { buildEntityKey } from "../types/informationTypes";
import type { InfoEntity, InfoFetchResult, FetchProgressEntry } from "../types/informationTypes";
import { emitInfoValueChanged } from "./infoValueEvents";

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

/**
 * An ok answer the chain should not stop at: plain lyrics. Synced beats plain
 * wherever it comes from, so a plain answer is held as a fallback while the
 * walk asks the rest of the chain for a synced version — otherwise plain text
 * embedded in a file (the local provider runs first) would hide the synced
 * lyrics a web provider has. Plain still wins when nobody further down has
 * synced.
 */
export function isProvisionalAnswer(typeId: string, value: unknown): boolean {
  return typeId === "lyrics" && (value as { kind?: unknown } | null)?.kind === "plain";
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
  /** Every provider of the type, when `providers` is a narrowed walk (a pinned
   *  fetch). Their rows are the ones to drop afterwards: a pinned write that
   *  left another provider's row behind gave the entity two cached values for
   *  one type, and readers keep whichever the map met last. Defaults to
   *  `providers`. */
  allProviders?: Array<[string, number]>;
}

/** Walk the provider chain (first ok wins), persist the outcome into the
 *  shared cache (`info_upsert_value`) and drop other providers' stale rows.
 *  Never throws — a thrown provider is recorded as an error status, exactly
 *  as the detail pages have always behaved. */
export async function fetchInfoThroughChain(
  opts: FetchChainOpts,
): Promise<{ result: InfoFetchResult; usedIntegerId: number }> {
  const { typeId, providers, entity, entityKey, invokeInfoFetch, pluginNames, onProgress } = opts;
  const allProviders = opts.allProviders ?? providers;
  let usedIntegerId = providers[0]?.[1] ?? 0;
  const steps: FetchProgressEntry[] = [];
  try {
    let result: InfoFetchResult = { status: "error" };
    // The first provisional ok (plain lyrics) seen, held while the walk looks
    // on for a better answer; used only when none turns up.
    let fallback: { result: InfoFetchResult; integerId: number } | null = null;

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
      if (result.status === "ok") {
        if (!isProvisionalAnswer(typeId, result.value)) break;
        fallback ??= { result, integerId };
      }
    }
    // No better answer further down: the first provisional one stands, which
    // keeps the user's provider priority among equals.
    if (fallback && (result.status !== "ok" || isProvisionalAnswer(typeId, result.value))) {
      result = fallback.result;
      usedIntegerId = fallback.integerId;
    }

    await invoke("info_upsert_value", {
      informationTypeId: usedIntegerId,
      entityKey,
      value: result.status === "ok" ? JSON.stringify(result.value) : "{}",
      status: result.status,
    });

    // Clean up stale cached values from other providers for this type_id
    for (const [, integerId] of allProviders) {
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

// ---------------------------------------------------------------------------
// One info type for one entity, cache-first — the operation behind the control
// API's `info.fetch` AND a plugin's `api.informationTypes.fetch`. Both callers
// must get the answer the detail page would render, so the type lookup, the
// fresh-cache serve, the provider pinning and the chain walk live here.
// ---------------------------------------------------------------------------

// Info-type rows as the backend returns them (same tuples useInformationTypes reads):
// [type_id, name, display_kind, ttl, sort_order, providers: [plugin_id, integer_id][], description]
export type InfoTypeRow = [string, string, string, number, number, Array<[string, number]>, string];
// [integer_id, type_id, value, status, fetched_at]
export type InfoValueRow = [number, string, string, string, number];

/** A request the caller got wrong (unknown type, pinned plugin that isn't a
 *  provider, …) — as opposed to a provider failing, which is reported as a
 *  `status: "error"` outcome and never thrown. Callers surface the message
 *  verbatim (a 400 body, a plugin promise rejection). */
export class InfoFetchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfoFetchRequestError";
  }
}

export interface FetchInfoValueOpts {
  typeId: string;
  entity: InfoEntity;
  /** Pin the fetch to ONE plugin's provider instead of walking the user-ordered
   *  chain. A pinned fetch also bypasses the fresh-cache serve — the cached
   *  value may have come from a different provider, and pinning means "I want
   *  THIS plugin's answer". */
  pluginId?: string;
  /** Re-run the chain even when the cache is fresh. */
  force?: boolean;
  invokeInfoFetch: InvokeInfoFetch;
  pluginNames?: Map<string, string>;
}

export interface FetchInfoValueOutcome {
  typeId: string;
  /** The type's display name (e.g. "Review"). */
  name: string;
  displayKind: string;
  status: "ok" | "not_found" | "error";
  /** A fresh cache row, or a chain walk this call ran. */
  source: "cache" | "fetch";
  value: unknown;
}

function parseStoredValue(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

/** Best-effort library id for an entity built from metadata — some plugin
 *  handlers key on `entity.id`; 0 = not in library, which every provider
 *  already tolerates (restored queues fetch that way). Never throws. */
export async function resolveInfoEntityId(entity: Omit<InfoEntity, "id">): Promise<number> {
  const { kind, name, artistName, albumTitle } = entity;
  try {
    if (kind === "track") {
      return (await invoke<{ id: number } | null>("find_track_by_metadata", {
        title: name, artistName: artistName ?? null, albumName: albumTitle ?? null,
      }))?.id ?? 0;
    }
    if (kind === "artist") {
      return (await invoke<{ id: number } | null>("find_artist_by_name", { name }))?.id ?? 0;
    }
    if (kind === "album") {
      return (await invoke<{ id: number } | null>("find_album_by_name", {
        title: name, artistName: artistName ?? null,
      }))?.id ?? 0;
    }
    return (await invoke<{ id: number } | null>("find_tag_by_name", { name }))?.id ?? 0;
  } catch (e) {
    console.error("Info entity id lookup failed:", e);
    return 0;
  }
}

/**
 * Put a value in the cache for one entity by hand — the lyrics editor, and a
 * plugin's `api.lyrics.save` (e.g. importing shared synced lyrics). It replaces
 * whatever any provider had cached for that type, and every open view re-reads.
 *
 * The row it lands under matters for how long it lasts: a `core:` (local-file)
 * row is re-probed daily (see cacheTtlForRow), which would wipe a hand-saved
 * value overnight. So it reuses the entity's current row when that's a web
 * provider's, else the first web provider in the chain — and only falls back
 * to a core row when the type has nothing else.
 */
export async function saveInfoValue(opts: { typeId: string; entity: InfoEntity; value: unknown }): Promise<void> {
  const { typeId, entity, value } = opts;
  const entityKey = buildEntityKey(entity);
  const types = await invoke<InfoTypeRow[]>("info_get_types_for_entity", { entity: entity.kind });
  const row = types.find(([id]) => id === typeId);
  if (!row || row[5].length === 0) {
    throw new InfoFetchRequestError(`no providers registered for "${typeId}" — is a ${typeId} plugin enabled?`);
  }
  const providers = row[5];
  const isCore = (id: number) => providers.some(([pid, pidId]) => pidId === id && pid.startsWith("core:"));
  const cached = await invoke<InfoValueRow[]>("info_get_values_for_entity", { entityKey });
  const current = cached.find(([, id]) => id === typeId)?.[0];
  const target =
    current !== undefined && !isCore(current)
      ? current
      : (providers.find(([pid]) => !pid.startsWith("core:")) ?? providers[0])[1];
  await invoke("info_upsert_value", { informationTypeId: target, entityKey, value: JSON.stringify(value), status: "ok" });
  for (const [, integerId] of providers) {
    if (integerId !== target) {
      await invoke("info_delete_value", { informationTypeId: integerId, entityKey }).catch(() => {}); // eslint-disable-line no-restricted-syntax -- Fire-and-forget: dropping a stale cache row; the saved value above is the real work
    }
  }
  emitInfoValueChanged(entityKey, typeId);
}

/**
 * `api.informationTypes.setSectionData`'s arguments, checked, as
 * `saveOwnInfoValue` takes them. The value lands under the exact page key
 * (`buildEntityKey`), so the entity is kept exactly as the plugin was given it
 * — a trimmed name or a non-string artist writes a row no page reads. A
 * missing artist is fine: an unknown-artist track's page has none.
 */
export function sectionDataRequest(typeId: unknown, entity: unknown, data: unknown): { typeId: string; entity: InfoEntity; value: unknown } {
  const fail = (why: string): never => { throw new Error(`informationTypes.setSectionData: ${why}`); };
  if (typeof typeId !== "string" || !typeId) fail("typeId is required");
  const e = (entity && typeof entity === "object" ? entity : {}) as Record<string, unknown>;
  const kind = e.kind;
  if (kind !== "artist" && kind !== "album" && kind !== "track" && kind !== "tag") fail("entity needs a kind (artist, album, track or tag)");
  if (typeof e.name !== "string" || !e.name.trim()) fail("entity needs a name");
  for (const field of ["artistName", "albumTitle"] as const) {
    if (e[field] != null && typeof e[field] !== "string") {
      fail(`entity.${field} must be a string — pass the entity onFetch or the action payload gave you`);
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("data must be an object (what onFetch returns as value)");
  const target: InfoEntity = { kind: kind as InfoEntity["kind"], name: e.name as string, id: typeof e.id === "number" ? e.id : 0 };
  if (e.artistName) target.artistName = e.artistName as string;
  if (e.albumTitle) target.albumTitle = e.albumTitle as string;
  return { typeId: typeId as string, entity: target, value: data };
}

/**
 * A plugin replacing the value one of its OWN information types shows for an
 * entity (`api.informationTypes.setSectionData`): an interactive tab after a
 * like or a post, with no refetch. Written under that plugin's row only —
 * unlike `saveInfoValue`, nothing another provider cached is touched — and
 * announced, so every open view re-reads it.
 */
export async function saveOwnInfoValue(opts: { pluginId: string; typeId: string; entity: InfoEntity; value: unknown }): Promise<void> {
  const { pluginId, typeId, entity, value } = opts;
  const entityKey = buildEntityKey(entity);
  const types = await invoke<InfoTypeRow[]>("info_get_types_for_entity", { entity: entity.kind });
  const row = types.find(([id]) => id === typeId);
  const own = row?.[5].find(([pid]) => pid === pluginId);
  if (!own) {
    throw new InfoFetchRequestError(`"${typeId}" is not one of this plugin's information types for ${entity.kind} entities`);
  }
  await invoke("info_upsert_value", { informationTypeId: own[1], entityKey, value: JSON.stringify(value), status: "ok" });
  emitInfoValueChanged(entityKey, typeId);
}

/**
 * Get one info type's value for one entity: a fresh cache row is served as-is
 * (unless `force` / `pluginId`), anything else walks the SAME provider chain
 * the detail pages run (`fetchInfoThroughChain`), so the result lands in the
 * shared cache and the page renders it for free afterwards.
 *
 * Throws `InfoFetchRequestError` only for a malformed request; a provider
 * failure comes back as `status: "error"`.
 */
export async function fetchInfoValue(opts: FetchInfoValueOpts): Promise<FetchInfoValueOutcome> {
  const { typeId, entity, pluginId: targetPlugin, force, invokeInfoFetch, pluginNames } = opts;
  const entityKey = buildEntityKey(entity);
  const types = await invoke<InfoTypeRow[]>("info_get_types_for_entity", { entity: entity.kind });
  const row = types.find(([id]) => id === typeId);
  if (!row) {
    throw new InfoFetchRequestError(
      `type "${typeId}" is not registered for ${entity.kind} entities (available: ${types.map((t) => t[0]).join(", ") || "none"})`,
    );
  }
  const [, name, displayKind, ttl, , providers] = row;

  const chain = targetPlugin ? providers.filter(([pid]) => pid === targetPlugin) : providers;
  if (targetPlugin && chain.length === 0) {
    throw new InfoFetchRequestError(
      `plugin "${targetPlugin}" is not a provider of "${typeId}" (providers: ${providers.map((p) => p[0]).join(", ") || "none"})`,
    );
  }

  if (!targetPlugin && !force) {
    const cached = await invoke<InfoValueRow[]>("info_get_values_for_entity", { entityKey });
    const c = cached.find(([, id]) => id === typeId);
    const now = Math.floor(Date.now() / 1000);
    // Local (`core:`) rows and misses on a type with a local provider expire
    // daily — the answer can change on disk. See cacheTtlForRow.
    if (c && decideCacheAction(c[3], c[4], cacheTtlForRow(providers, c[0], c[3], ttl), now) === "render") {
      return { typeId, name, displayKind, status: "ok", source: "cache", value: parseStoredValue(c[2]) };
    }
  }
  if (chain.length === 0) {
    throw new InfoFetchRequestError(`no providers registered for "${typeId}" — is the plugin enabled?`);
  }
  const { result } = await fetchInfoThroughChain({
    typeId, providers: chain, allProviders: providers, entity, entityKey, invokeInfoFetch, pluginNames,
  });
  // A plugin or the control API changed what this entity shows — tell any open
  // detail page / Now Playing view, which otherwise re-reads only when its
  // entity changes. (The pages' own walks don't announce: they render what
  // they fetched themselves.)
  emitInfoValueChanged(entityKey, typeId);
  return {
    typeId,
    name,
    displayKind,
    status: result.status,
    source: "fetch",
    value: result.status === "ok" ? result.value : null,
  };
}
