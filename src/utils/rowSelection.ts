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
