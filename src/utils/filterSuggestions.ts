/**
 * Pure helper for autocomplete suggestion filtering.
 * Case-insensitive substring match, excludes already-chosen names, caps the list.
 */
export function filterSuggestions(
  pool: string[],
  query: string,
  exclude?: Set<string>,
  cap = 8,
): string[] {
  const q = query.trim().toLowerCase();
  const excludeLower = exclude
    ? new Set([...exclude].map((s) => s.toLowerCase()))
    : undefined;
  const out: string[] = [];
  for (const item of pool) {
    const lower = item.toLowerCase();
    if (excludeLower && excludeLower.has(lower)) continue;
    if (q && !lower.includes(q)) continue;
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}
