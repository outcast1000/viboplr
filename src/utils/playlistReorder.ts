// Pure drop-index math for the playlist detail's drag-to-reorder.
// Extracted so the permutation is unit-testable without a DOM drag.

/**
 * Reorder `ids` by moving `movedIds` (kept in their current relative order) to
 * `insertAt` — an insertion index in the ORIGINAL array (0..ids.length), i.e.
 * "before the row currently at that index". Returns a new array; returns the
 * input unchanged (same reference) when the move is a no-op.
 */
export function computeReorderedIds(ids: number[], movedIds: number[], insertAt: number): number[] {
  const moved = new Set(movedIds);
  const movedInOrder = ids.filter(id => moved.has(id));
  if (movedInOrder.length === 0) return ids;
  const rest = ids.filter(id => !moved.has(id));
  // Shift the insertion point left by every moved row that sat before it.
  let adjusted = Math.max(0, Math.min(insertAt, ids.length));
  for (let i = 0; i < ids.length && i < insertAt; i++) {
    if (moved.has(ids[i])) adjusted--;
  }
  const out = [...rest.slice(0, adjusted), ...movedInOrder, ...rest.slice(adjusted)];
  return out.every((id, i) => id === ids[i]) ? ids : out;
}
