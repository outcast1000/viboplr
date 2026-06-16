import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** A tag present on only some of an entity's tracks. */
export interface PartialTag {
  name: string;
  count: number;
  total: number;
}

export interface EntityTagState {
  /** Tags present on ALL of the entity's tracks. */
  applied: string[];
  /** Tags present on some-but-not-all tracks (n of m). */
  partial: PartialTag[];
}

const ci = (s: string) => s.toLowerCase();

/**
 * Pure classifier: given the backend's `(tagId, name, count)` rows and the total
 * track count, split tags into fully-applied (count === total) and partial
 * (0 < count < total). Sorted case-insensitively by name. Extracted from the
 * hook so it can be unit-tested without React/Tauri.
 */
export function classifyTagCounts(
  rows: Array<[number, string, number]>,
  total: number,
): EntityTagState {
  const applied: string[] = [];
  const partial: PartialTag[] = [];
  for (const [, name, count] of rows) {
    if (total > 0 && count >= total) applied.push(name);
    else if (count > 0) partial.push({ name, count, total });
  }
  const byName = (a: string, b: string) => ci(a).localeCompare(ci(b));
  applied.sort(byName);
  partial.sort((a, b) => byName(a.name, b.name));
  return { applied, partial };
}

function dedupCI(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const k = ci(n);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(n);
    }
  }
  return out;
}

export interface UseEntityTagsOptions {
  /** Called after a successful write so the host can refresh library tag state. */
  onMutated?: () => void;
}

export interface UseEntityTags extends EntityTagState {
  /** True until the first aggregation resolves (re-aggregations are silent). */
  loading: boolean;
  /** True while a write is in flight — hosts disable controls. */
  pending: boolean;
  /** Apply a tag to ALL the entity's tracks (also used for fill-to-all). */
  apply: (name: string) => void;
  /** Promote a partial tag to all tracks (alias of apply). */
  fillToAll: (name: string) => void;
  /** Remove a tag from every track that carries it. */
  remove: (name: string) => void;
}

/**
 * Aggregate the tags across an entity's tracks (album or artist) and apply /
 * fill / remove them across the whole set, DB-only and optimistically.
 *
 * Reads `get_tag_counts_for_tracks` over the non-null track IDs (the same
 * collection-filtered set the detail page lists), classifies full vs partial,
 * and exposes optimistic mutators that call the batched commands, revert on
 * failure (console.error), and re-confirm from the DB via a `refetchKey` bump —
 * distinct from the track-set key, since a tag write doesn't change the tracks.
 */
export function useEntityTags(
  tracks: ReadonlyArray<{ id: number | null }>,
  opts?: UseEntityTagsOptions,
): UseEntityTags {
  const trackIds = useMemo(
    () => tracks.map((t) => t.id).filter((id): id is number => id != null),
    [tracks],
  );
  const trackIdsKey = trackIds.join(",");
  const total = trackIds.length;

  const [state, setState] = useState<EntityTagState>({ applied: [], partial: [] });
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [refetchKey, setRefetchKey] = useState(0);

  const stateRef = useRef(state);
  stateRef.current = state;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const onMutated = opts?.onMutated;

  // New entity → show loading and clear stale chips. Keyed on the track set only,
  // so a post-write refetch (refetchKey bump) stays silent.
  useEffect(() => {
    setLoading(true);
    setState({ applied: [], partial: [] });
  }, [trackIdsKey]);

  // Aggregate from the DB. Re-runs when the track set changes or after a write.
  useEffect(() => {
    if (total === 0) {
      setState({ applied: [], partial: [] });
      setLoading(false);
      return;
    }
    let cancelled = false;
    invoke<Array<[number, string, number]>>("get_tag_counts_for_tracks", { trackIds })
      .then((rows) => {
        if (cancelled) return;
        setState(classifyTagCounts(rows, total));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load entity tags:", e);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // trackIds is derived from trackIdsKey; depend on the stable key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackIdsKey, refetchKey, total]);

  const runWrite = useCallback(
    async (
      command: "apply_tag_to_tracks" | "remove_tag_from_tracks",
      tagName: string,
      optimistic: (prev: EntityTagState) => EntityTagState,
    ) => {
      if (total === 0) return;
      const prev = stateRef.current;
      setState(optimistic(prev));
      setPending(true);
      try {
        await invoke(command, { trackIds, tagName });
        onMutated?.();
        if (mountedRef.current) setRefetchKey((k) => k + 1);
      } catch (e) {
        console.error(`Failed to ${command === "apply_tag_to_tracks" ? "apply" : "remove"} tag:`, e);
        if (mountedRef.current) setState(prev);
      } finally {
        if (mountedRef.current) setPending(false);
      }
    },
    [total, trackIds, onMutated],
  );

  const apply = useCallback(
    (name: string) =>
      void runWrite("apply_tag_to_tracks", name, (prev) => ({
        applied: dedupCI([...prev.applied, name]),
        partial: prev.partial.filter((p) => ci(p.name) !== ci(name)),
      })),
    [runWrite],
  );

  const remove = useCallback(
    (name: string) =>
      void runWrite("remove_tag_from_tracks", name, (prev) => ({
        applied: prev.applied.filter((t) => ci(t) !== ci(name)),
        partial: prev.partial.filter((p) => ci(p.name) !== ci(name)),
      })),
    [runWrite],
  );

  return {
    applied: state.applied,
    partial: state.partial,
    loading,
    pending,
    apply,
    fillToAll: apply,
    remove,
  };
}
