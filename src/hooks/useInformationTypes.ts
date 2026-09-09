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
import { decideCacheAction, fetchInfoThroughChain } from "../utils/infoFetchChain";

const EMPTY_DELAY_MS = 3000; // show progress for 3s before switching to empty

interface UseInformationTypesOpts {
  entity: InfoEntity | null;
  exclude?: string[];
  /** If set, only these type IDs are loaded (all others skipped). */
  include?: string[];
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
  disabled,
  invokeInfoFetch,
  pluginNames,
}: UseInformationTypesOpts) {
  const [sections, setSections] = useState<InfoSection[]>([]);
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
  const entityKeyRef = useRef<string>("");

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
    }> = [];

    typeMetaRef.current.clear();
    for (const [typeId, name, displayKind, ttl, _sortOrder, providers, description] of types) {
      typeMetaRef.current.set(typeId, { displayKind: displayKind as DisplayKind, name, providers });
      if (excludeSet?.has(typeId)) continue;
      if (includeSet && !includeSet.has(typeId)) continue;

      const entry = cacheMap.get(typeId);
      const action = decideCacheAction(
        entry?.status ?? null,
        entry?.fetchedAt ?? null,
        ttl,
        now,
      );

      const desc = description || undefined;

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

      if (action === "render" || action === "render_and_refetch") {
        let parsed: unknown;
        try { parsed = JSON.parse(entry!.value); } catch { parsed = null; }
        newSections.push({
          typeId,
          name,
          description: desc,
          displayKind: displayKind as DisplayKind,
          state: { kind: "loaded", data: parsed, stale: action === "render_and_refetch" },
        });
        if (action === "render_and_refetch") {
          fetchNeeded.push({ typeId, providers, index: idx });
        }
      } else {
        // loading
        newSections.push({
          typeId,
          name,
          description: desc,
          displayKind: displayKind as DisplayKind,
          state: { kind: "loading" },
        });
        fetchNeeded.push({ typeId, providers, index: idx });
      }
    }

    if (mountedRef.current) setSections(newSections);

    // 4. Fire fetches with provider fallback
    for (const { typeId, providers } of fetchNeeded) {
      const dedupKey = `${typeId}:${entityKey}`;
      if (inFlightRef.current.has(dedupKey)) continue;
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
          const { result } = await fetchInfoThroughChain({
            typeId, providers, entity, entityKey,
            invokeInfoFetch, pluginNames,
            onProgress: updateProgress,
          });

          if (mountedRef.current && entityKeyRef.current === entityKey && result.status === "ok") {
            setSections((prev) => {
              const next = [...prev];
              const existing = next.find((s) => s.typeId === typeId);
              if (existing) {
                existing.state = { kind: "loaded", data: result.value, stale: false };
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
  }, [entity?.kind, entity?.id, entity?.name, entity?.artistName, excludeKey, includeKey, disabled, invokeInfoFetch]);

  useEffect(() => {
    loadSections();
  }, [loadSections]);

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

  const getTypeMeta = useCallback(
    (typeId: string) => typeMetaRef.current.get(typeId),
    [],
  );

  return { sections, refresh, reloadCache: loadSections, getTypeMeta };
}
