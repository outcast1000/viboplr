import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  InfoEntity,
  InfoSection,
  DisplayKind,
  InfoFetchResult,
} from "../types/informationTypes";
import { buildEntityKey } from "../types/informationTypes";

const ERROR_TTL = 3600; // 1 hour in seconds

type CacheAction = "render" | "render_and_refetch" | "loading" | "hidden";

function decideCacheAction(
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
  return stale ? "loading" : "hidden";
}

interface UseInformationTypesOpts {
  entity: InfoEntity | null;
  exclude?: string[];
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
  ) => Promise<InfoFetchResult>;
}

// Backend returns: [type_id, name, display_kind, ttl, sort_order, providers: [plugin_id, integer_id][]]
type BackendTypeRow = [string, string, string, number, number, Array<[string, number]>];
// Backend returns: [integer_id, type_id, value, status, fetched_at]
type BackendValueRow = [number, string, string, string, number];

export function useInformationTypes({
  entity,
  exclude,
  invokeInfoFetch,
}: UseInformationTypesOpts) {
  const [sections, setSections] = useState<InfoSection[]>([]);
  const inFlightRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const excludeKey = exclude?.join(",") ?? "";
  const entityKeyRef = useRef<string>("");

  const loadSections = useCallback(async () => {
    if (!entity) {
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

    for (const [typeId, name, displayKind, ttl, _sortOrder, providers] of types) {
      if (excludeSet?.has(typeId)) continue;

      const entry = cacheMap.get(typeId);
      const action = decideCacheAction(
        entry?.status ?? null,
        entry?.fetchedAt ?? null,
        ttl,
        now,
      );

      if (action === "hidden") continue;

      const idx = newSections.length;

      if (action === "render" || action === "render_and_refetch") {
        let parsed: unknown;
        try { parsed = JSON.parse(entry!.value); } catch { parsed = null; }
        newSections.push({
          typeId,
          name,
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
        let usedIntegerId = providers[0]?.[1] ?? 0;
        try {
          let result: InfoFetchResult = { status: "error" };

          // Try providers in priority order (fallback chain)
          for (const [pluginId, integerId] of providers) {
            result = await invokeInfoFetch(pluginId, typeId, entity);
            usedIntegerId = integerId;
            if (result.status === "ok") break;
          }

          const value = result.status === "ok" ? JSON.stringify(result.value) : "{}";
          await invoke("info_upsert_value", {
            informationTypeId: usedIntegerId,
            entityKey,
            value,
            status: result.status,
          });

          // Clean up stale cached values from other providers for this type_id
          for (const [, integerId] of providers) {
            if (integerId !== usedIntegerId) {
              await invoke("info_delete_value", {
                informationTypeId: integerId,
                entityKey,
              }).catch(() => {});
            }
          }

          if (mountedRef.current && entityKeyRef.current === entityKey && result.status === "ok") {
            setSections((prev) => {
              const next = [...prev];
              const existing = next.find((s) => s.typeId === typeId);
              if (existing) {
                existing.state = { kind: "loaded", data: (result as any).value, stale: false };
              }
              return next;
            });
          } else if (mountedRef.current && entityKeyRef.current === entityKey && result.status !== "ok") {
            setSections((prev) => prev.filter((s) => s.typeId !== typeId));
          }
        } catch {
          await invoke("info_upsert_value", {
            informationTypeId: usedIntegerId,
            entityKey,
            value: "{}",
            status: "error",
          }).catch(() => {});
          if (mountedRef.current && entityKeyRef.current === entityKey) {
            setSections((prev) => prev.filter((s) => s.typeId !== typeId));
          }
        } finally {
          inFlightRef.current.delete(dedupKey);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity?.kind, entity?.id, entity?.name, entity?.artistName, excludeKey, invokeInfoFetch]);

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

  return { sections, refresh };
}
