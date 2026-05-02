export type SortDir = "asc" | "desc";

export interface SortKey {
  field: string;
  dir: SortDir;
}

export function toggleSortKey(chain: SortKey[], field: string, shiftKey: boolean): SortKey[] {
  const idx = chain.findIndex(k => k.field === field);

  if (!shiftKey) {
    if (chain.length === 1 && idx === 0) {
      return [{ field, dir: chain[0].dir === "asc" ? "desc" : "asc" }];
    }
    return [{ field, dir: "asc" }];
  }

  if (idx >= 0) {
    return chain.map((k, i) =>
      i === idx ? { ...k, dir: k.dir === "asc" ? "desc" : "asc" } : k
    );
  }

  return [...chain, { field, dir: "asc" }];
}

export function chainPosition(chain: SortKey[], field: string): number {
  return chain.findIndex(k => k.field === field);
}

export function chainDir(chain: SortKey[], field: string): SortDir | null {
  const entry = chain.find(k => k.field === field);
  return entry ? entry.dir : null;
}
