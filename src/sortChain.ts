export type SortDir = "asc" | "desc";

export interface SortKey {
  field: string;
  dir: SortDir;
}

/** Fields whose first click sorts DESCENDING.
 *
 * Ascending is the right opening move for a name or a title, and the wrong one
 * for a date: nobody asks for "Added" wanting the oldest thing in the library
 * first — the question behind the button is always "what's new?". Same for
 * "Modified". Everything else keeps the ascending default, and the second
 * click still flips, so nothing becomes unreachable. */
const DESC_FIRST_FIELDS = new Set(["added", "modified"]);

function firstDir(field: string): SortDir {
  return DESC_FIRST_FIELDS.has(field) ? "desc" : "asc";
}

export function toggleSortKey(chain: SortKey[], field: string, shiftKey: boolean): SortKey[] {
  const idx = chain.findIndex(k => k.field === field);

  if (!shiftKey) {
    if (chain.length === 1 && idx === 0) {
      return [{ field, dir: chain[0].dir === "asc" ? "desc" : "asc" }];
    }
    return [{ field, dir: firstDir(field) }];
  }

  if (idx >= 0) {
    return chain.map((k, i) =>
      i === idx ? { ...k, dir: k.dir === "asc" ? "desc" : "asc" } : k
    );
  }

  return [...chain, { field, dir: firstDir(field) }];
}

export function chainPosition(chain: SortKey[], field: string): number {
  return chain.findIndex(k => k.field === field);
}

export function chainDir(chain: SortKey[], field: string): SortDir | null {
  const entry = chain.find(k => k.field === field);
  return entry ? entry.dir : null;
}
