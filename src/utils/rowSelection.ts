// The single multi-select algorithm shared by every track-row surface
// (library table + list, playlist detail, plugin views, history, queue).
// Generic over the row key type K: string for key/id-based lists, number for
// the index-keyed queue. Callers pass the ordered array of row keys; selection
// state itself stays owned by the parent view.
//
// Behavior (mirrors the historical per-surface copies exactly):
//   shift            -> range from lastIndex..clickedIndex (replaces selection)
//   shift + meta     -> that range unioned into the current selection
//   meta             -> toggle the clicked key in/out
//   plain            -> select only the clicked key
export function computeSelection<K>(
  current: Set<K>,
  clickedIndex: number,
  keys: K[],
  lastIndex: number | null,
  meta: boolean,
  shift: boolean,
): Set<K> {
  if (shift) {
    const start = lastIndex ?? 0;
    const lo = Math.min(start, clickedIndex);
    const hi = Math.max(start, clickedIndex);
    const range = new Set(keys.slice(lo, hi + 1));
    if (meta) {
      const merged = new Set(current);
      for (const k of range) merged.add(k);
      return merged;
    }
    return range;
  }
  if (meta) {
    const next = new Set(current);
    const k = keys[clickedIndex];
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  }
  return new Set([keys[clickedIndex]]);
}

/** The index-keyed specialization (the queue's Set<number> of row indices):
 *  the row keys ARE 0..N, so callers don't pass a keys array — it's generated
 *  up to the highest index the click can touch. Behavior matches the generic
 *  exactly; this replaces the private copy QueuePanel used to carry. */
export function computeIndexSelection(
  current: Set<number>,
  clickedIndex: number,
  lastIndex: number | null,
  meta: boolean,
  shift: boolean,
): Set<number> {
  const hi = Math.max(clickedIndex, lastIndex ?? 0);
  const keys = Array.from({ length: hi + 1 }, (_, i) => i);
  return computeSelection(current, clickedIndex, keys, lastIndex, meta, shift);
}
