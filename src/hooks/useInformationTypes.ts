import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  InfoEntity,
  InfoSection,
  DisplayKind,
  InfoFetchResult,
} from "../types/informationTypes";

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

  const loadSections = useCallback(async () => {
    if (!entity) {
      setSections([]);
      return;
    }

    // 1. Query registered info types for this entity kind
    const types = await invoke<Array<[string, string, string, string, number, number, number]>>(
      "info_get_types_for_entity",
      { entity: entity.kind },
    );

    // 2. Query all cached values for this entity
    const entityKey = `${entity.kind}:${entity.id}`;
    const cached = await invoke<Array<[string, string, string, number]>>(
      "info_get_values_for_entity",
      { entityKey },
    );
    const cacheMap = new Map(cached.map(([typeId, value, status, fetchedAt]) => [typeId, { value, status, fetchedAt }]));

    const now = Math.floor(Date.now() / 1000);

    // Deduplicate info types by id (pick lowest sort_order per id).
    // TODO: Multi-provider fallback — when multiple plugins register the same ID,
    // query info_get_providers for user-configured priority and try providers in order.
    // For now, uses the first provider (lowest sort_order) only.
    const seenIds = new Set<string>();
    const uniqueTypes: Array<{ id: string; name: string; displayKind: DisplayKind; pluginId: string; ttl: number }> = [];
    for (const [id, name, displayKind, pluginId, ttl] of types) {
      if (seenIds.has(id)) continue;
      if (exclude?.includes(id)) continue;
      seenIds.add(id);
      uniqueTypes.push({ id, name, displayKind: displayKind as DisplayKind, pluginId, ttl });
    }

    // 3. Build initial section states
    const newSections: InfoSection[] = [];
    const fetchNeeded: Array<{ typeId: string; pluginId: string; index: number }> = [];

    for (const t of uniqueTypes) {
      const entry = cacheMap.get(t.id);
      const action = decideCacheAction(
        entry?.status ?? null,
        entry?.fetchedAt ?? null,
        t.ttl,
        now,
      );

      if (action === "hidden") continue;

      const idx = newSections.length;

      if (action === "render" || action === "render_and_refetch") {
        let parsed: unknown;
        try { parsed = JSON.parse(entry!.value); } catch { parsed = null; }
        newSections.push({
          typeId: t.id,
          name: t.name,
          displayKind: t.displayKind,
          state: { kind: "loaded", data: parsed, stale: action === "render_and_refetch" },
        });
        if (action === "render_and_refetch") {
          fetchNeeded.push({ typeId: t.id, pluginId: t.pluginId, index: idx });
        }
      } else {
        // loading
        newSections.push({
          typeId: t.id,
          name: t.name,
          displayKind: t.displayKind,
          state: { kind: "loading" },
        });
        fetchNeeded.push({ typeId: t.id, pluginId: t.pluginId, index: idx });
      }
    }

    if (mountedRef.current) setSections(newSections);

    // 4. Fire fetches in parallel
    for (const { typeId, pluginId } of fetchNeeded) {
      const dedupKey = `${typeId}:${entityKey}`;
      if (inFlightRef.current.has(dedupKey)) continue;
      inFlightRef.current.add(dedupKey);

      (async () => {
        try {
          const result = await invokeInfoFetch(pluginId, typeId, entity);
          const value = result.status === "ok" ? JSON.stringify(result.value) : "{}";
          await invoke("info_upsert_value", {
            typeId,
            entityKey,
            value,
            status: result.status,
          });

          if (mountedRef.current && result.status === "ok") {
            setSections((prev) => {
              const next = [...prev];
              const existing = next.find((s) => s.typeId === typeId);
              if (existing) {
                existing.state = { kind: "loaded", data: result.value, stale: false };
              }
              return next;
            });
          } else if (mountedRef.current && result.status !== "ok") {
            // Remove section if fetch returned not_found or error
            setSections((prev) => prev.filter((s) => s.typeId !== typeId));
          }
        } catch {
          await invoke("info_upsert_value", {
            typeId,
            entityKey,
            value: "{}",
            status: "error",
          }).catch(() => {});
          if (mountedRef.current) {
            setSections((prev) => prev.filter((s) => s.typeId !== typeId));
          }
        } finally {
          inFlightRef.current.delete(dedupKey);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity?.kind, entity?.id, exclude, invokeInfoFetch]);
  // Note: entity.name deliberately excluded — cache is keyed by ID, not name.

  useEffect(() => {
    loadSections();
  }, [loadSections]);

  const refresh = useCallback(
    async (typeId: string) => {
      if (!entity) return;
      const entityKey = `${entity.kind}:${entity.id}`;
      // Delete cached value to force refetch
      await invoke("info_delete_value", { typeId, entityKey });
      loadSections();
    },
    [entity, loadSections],
  );

  return { sections, refresh };
}
