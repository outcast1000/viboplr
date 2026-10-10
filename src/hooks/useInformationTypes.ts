import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  InfoEntity,
  InfoSection,
  DisplayKind,
  InfoFetchResult,
  FetchProgressEntry,
} from "../types/informationTypes";
import { buildEntityKey } from "../types/informationTypes";
// The cache-decision rule and the provider-chain walk live in
// utils/infoFetchChain.ts, shared with the control API's info verbs.
import { cacheTtlForRow, decideCacheAction, fetchInfoThroughChain } from "../utils/infoFetchChain";
import { onInfoValueChanged } from "../utils/infoValueEvents";

const EMPTY_DELAY_MS = 3000; // show progress for 3s before switching to empty

/**
 * Kinds fetched only once the section is shown (`activate`), never just
 * because a page that has one opened. An interactive tab is the plugin's own
 * view of the entity — the Community tab asks its server as the signed-in
 * member — so opening a song page must not name the song to that server
 * before the user goes to the tab. A fresh cached value still draws at once.
 */
const LAZY_DISPLAY_KINDS: ReadonlySet<string> = new Set<DisplayKind>(["plugin_view"]);

interface UseInformationTypesOpts {
  entity: InfoEntity | null;
  exclude?: string[];
  /** If set, only these type IDs are loaded (all others skipped). */
  include?: string[];
  /** If set, only types of these display kinds are loaded. Filters by *shape*
   * rather than by id, so a surface that wants "prose about this entity" picks
   * up any plugin that provides one without naming that plugin's type ids. */
  includeKinds?: DisplayKind[];
  /** Load nothing at all: no type query, no cache reads, no fetches. For
   * entities where per-entity metadata is meaningless (a "Various Artists"
   * collective) — distinct from `include: []`, which means "no filter". */
  disabled?: boolean;
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
    onFetchUrl?: (url: string) => void,
  ) => Promise<InfoFetchResult>;
  /** Map from pluginId → display name, used for progress reporting */
  pluginNames?: Map<string, string>;
}

// Backend returns: [type_id, name, display_kind, ttl, sort_order, providers: [plugin_id, integer_id][], description]
type BackendTypeRow = [string, string, string, number, number, Array<[string, number]>, string];
// Backend returns: [integer_id, type_id, value, status, fetched_at]
type BackendValueRow = [number, string, string, string, number];

export function useInformationTypes({
  entity,
  exclude,
  include,
  includeKinds,
  disabled,
  invokeInfoFetch,
  pluginNames,
}: UseInformationTypesOpts) {
  const [sections, setSections] = useState<InfoSection[]>([]);
  // Which entity `sections` currently describes. Before the first type/cache
  // read lands, `sections` is `[]` for "no types" and "not read yet" alike;
  // `ready` below tells the two apart for callers that render an empty state.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const inFlightRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  // typeId → { displayKind, name, providers:[pluginId, integerId][] }, for the
  // Retrieve modal (provider list + how to render the preview).
  const typeMetaRef = useRef<Map<string, { displayKind: DisplayKind; name: string; providers: Array<[string, number]> }>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const excludeKey = exclude?.join(",") ?? "";
  const includeKey = include?.join(",") ?? "";
  const includeKindsKey = includeKinds?.join(",") ?? "";
  const entityKeyRef = useRef<string>("");
  // Lazy kinds: the fetches waiting for their tab (typeId → start), and the
  // types shown for an entity (typeId → entityKey), so a cache re-read while
  // the tab is open fetches straight away instead of waiting again.
  const deferredRef = useRef<Map<string, () => void>>(new Map());
  const activatedRef = useRef<Map<string, string>>(new Map());

  const loadSections = useCallback(async () => {
    if (!entity || disabled) {
      setSections([]);
      return;
    }

    // 1. Query registered info types for this entity kind (with provider chains)
    const types = await invoke<BackendTypeRow[]>(
      "info_get_types_for_entity",
      { entity: entity.kind },
    );

    // 2. Query all cached values for this entity (name-based key)
    const entityKey = buildEntityKey(entity);
    entityKeyRef.current = entityKey;
    const excludeSet = excludeKey ? new Set(excludeKey.split(",")) : null;
    const includeSet = includeKey ? new Set(includeKey.split(",")) : null;
    const includeKindSet = includeKindsKey ? new Set(includeKindsKey.split(",")) : null;
    const cached = await invoke<BackendValueRow[]>(
      "info_get_values_for_entity",
      { entityKey },
    );
    // Map from type_id string → { integerId, value, status, fetchedAt }
    const cacheMap = new Map(
      cached.map(([integerId, typeId, value, status, fetchedAt]) => [
        typeId,
        { integerId, value, status, fetchedAt },
      ]),
    );

    const now = Math.floor(Date.now() / 1000);

    // 3. Build section states with provider chains
    const newSections: InfoSection[] = [];
    const fetchNeeded: Array<{
      typeId: string;
      providers: Array<[string, number]>; // [pluginId, integerId]
      index: number;
      lazy: boolean;
    }> = [];

    typeMetaRef.current.clear();
    for (const [typeId, name, displayKind, ttl, _sortOrder, providers, description] of types) {
      typeMetaRef.current.set(typeId, { displayKind: displayKind as DisplayKind, name, providers });
      if (excludeSet?.has(typeId)) continue;
      if (includeSet && !includeSet.has(typeId)) continue;
      if (includeKindSet && !includeKindSet.has(displayKind)) continue;

      const desc = description || undefined;

      const entry = cacheMap.get(typeId);
      // A row from a local `core:` provider — or a miss on a type that has
      // one — expires after a day instead of the type's web TTL: the answer
      // can change on the user's own disk. See cacheTtlForRow.
      const action = decideCacheAction(
        entry?.status ?? null,
        entry?.fetchedAt ?? null,
        entry ? cacheTtlForRow(providers, entry.integerId, entry.status, ttl, typeId, entry.value) : ttl,
        now,
      );

      if (action === "empty") {
        newSections.push({
          typeId,
          name,
          description: desc,
          displayKind: displayKind as DisplayKind,
          state: { kind: "empty" },
        });
        continue;
      }

      const idx = newSections.length;
      const lazy = LAZY_DISPLAY_KINDS.has(displayKind) && activatedRef.current.get(typeId) !== entityKey;

      if (action === "render" || action === "render_and_refetch") {
        let parsed: unknown;
        try { parsed = JSON.parse(entry!.value); } catch { parsed = null; }
        newSections.push({
          typeId,
          name,
          description: desc,
          displayKind: displayKind as DisplayKind,
          state: {
            kind: "loaded",
            data: parsed,
            stale: action === "render_and_refetch",
            providerId: providers.find(([, id]) => id === entry!.integerId)?.[0],
          },
        });
        if (action === "render_and_refetch") {
          fetchNeeded.push({ typeId, providers, index: idx, lazy });
        }
      } else {
        // loading — or, for a lazy kind nobody has shown yet, waiting for its tab
        newSections.push({
          typeId,
          name,
          description: desc,
          displayKind: displayKind as DisplayKind,
          state: lazy ? { kind: "loading", deferred: true } : { kind: "loading" },
        });
        fetchNeeded.push({ typeId, providers, index: idx, lazy });
      }
    }

    if (mountedRef.current) {
      setSections(newSections);
      setLoadedKey(entityKey);
    }

    // 4. Fire fetches with provider fallback (a lazy one waits for `activate`)
    const deferred = new Map<string, () => void>();
    deferredRef.current = deferred;
    const target = entity; // narrowed above; a function body below can't see that
    for (const { typeId, providers, lazy } of fetchNeeded) {
      if (lazy) deferred.set(typeId, () => startFetch(typeId, providers));
      else startFetch(typeId, providers);
    }

    function startFetch(typeId: string, providers: Array<[string, number]>) {
      const dedupKey = `${typeId}:${entityKey}`;
      if (inFlightRef.current.has(dedupKey)) return;
      inFlightRef.current.add(dedupKey);

      (async () => {
        const updateProgress = (steps: FetchProgressEntry[]) => {
          if (!mountedRef.current || entityKeyRef.current !== entityKey) return;
          setSections((prev) => {
            const next = [...prev];
            const existing = next.find((s) => s.typeId === typeId);
            if (existing && existing.state.kind === "loading") {
              existing.state = { kind: "loading", progress: [...steps] };
            }
            return next;
          });
        };

        try {
          // The walk + cache writes live in utils/infoFetchChain.ts (shared
          // with the control API's info.fetch); this hook only renders.
          const { result, usedIntegerId } = await fetchInfoThroughChain({
            typeId, providers, entity: target, entityKey,
            invokeInfoFetch, pluginNames,
            onProgress: updateProgress,
          });

          if (mountedRef.current && entityKeyRef.current === entityKey && result.status === "ok") {
            setSections((prev) => {
              const next = [...prev];
              const existing = next.find((s) => s.typeId === typeId);
              if (existing) {
                existing.state = {
                  kind: "loaded",
                  data: result.value,
                  stale: false,
                  providerId: providers.find(([, id]) => id === usedIntegerId)?.[0],
                };
              }
              return next;
            });
          } else if (mountedRef.current && entityKeyRef.current === entityKey && result.status !== "ok") {
            setTimeout(() => {
              if (mountedRef.current && entityKeyRef.current === entityKey) {
                setSections((prev) => {
                  const next = [...prev];
                  const existing = next.find((s) => s.typeId === typeId);
                  if (existing) {
                    existing.state = { kind: "empty" };
                  }
                  return next;
                });
              }
            }, EMPTY_DELAY_MS);
          }
        } finally {
          inFlightRef.current.delete(dedupKey);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity?.kind, entity?.id, entity?.name, entity?.artistName, excludeKey, includeKey, includeKindsKey, disabled, invokeInfoFetch]);

  useEffect(() => {
    loadSections();
  }, [loadSections]);

  // A value for this entity was written from outside this view (a plugin's
  // fetch, the control API): re-read the cache. It was just written, so the
  // re-read renders it rather than fetching again.
  useEffect(
    () =>
      onInfoValueChanged((entityKey) => {
        if (entityKey === entityKeyRef.current) loadSections();
      }),
    [loadSections],
  );

  const refresh = useCallback(
    async (typeId: string) => {
      if (!entity) return;
      const entityKey = buildEntityKey(entity);
      // Find the cached value's integer ID to delete it
      const cached = await invoke<BackendValueRow[]>(
        "info_get_values_for_entity",
        { entityKey },
      );
      const entry = cached.find(([, tid]) => tid === typeId);
      if (entry) {
        await invoke("info_delete_value", {
          informationTypeId: entry[0],
          entityKey,
        });
      }
      loadSections();
    },
    [entity, loadSections],
  );

  /** A section is being shown: run its fetch if it was waiting for that. */
  const activate = useCallback((typeId: string) => {
    const entityKey = entityKeyRef.current;
    if (!entityKey) return;
    activatedRef.current.set(typeId, entityKey);
    const start = deferredRef.current.get(typeId);
    if (!start) return;
    deferredRef.current.delete(typeId);
    setSections((prev) => prev.map((s) =>
      s.typeId === typeId && s.state.kind === "loading" && s.state.deferred ? { ...s, state: { kind: "loading" } } : s,
    ));
    start();
  }, []);

  const getTypeMeta = useCallback(
    (typeId: string) => typeMetaRef.current.get(typeId),
    [],
  );

  const ready = !entity || disabled ? true : loadedKey === buildEntityKey(entity);

  return { sections, ready, refresh, reloadCache: loadSections, getTypeMeta, activate };
}
