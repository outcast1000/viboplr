// The one implementation of "reconcile in-memory like state against the
// durable entity_likes store". Five surfaces used to re-derive this by hand
// (queue adds, startup restore, current-track identity changes, the
// entity-likes-changed listener, playlist detail rows), each re-stating the
// dedup, the metadata identity, and the apply-without-churning rules — with
// the identity helper literally declared twice.
import { invoke } from "@tauri-apps/api/core";
import { normalizeForMatch } from "./normalize";

/** Anything carrying the metadata the durable like key is built from. */
export interface LikeIdentified {
  title: string;
  artist_name?: string | null;
  liked?: number;
}

/** Metadata identity for like state — the same dimension (normalized
 *  title + artist) as the backend's entity_likes key. */
export function trackLikeId(title: string | null | undefined, artist: string | null | undefined): string {
  return `${normalizeForMatch(title ?? "")}:${normalizeForMatch(artist ?? "")}`;
}

/** Dedup by trackLikeId, then batch-read authoritative states from the
 *  backend. Returns id → state (0 = no durable row) for every requested
 *  identity; empty input skips the round-trip. */
export async function fetchLikeStates(
  tracks: Iterable<LikeIdentified | null | undefined>,
): Promise<Map<string, number>> {
  const seen = new Set<string>();
  const items: { title: string; artistName: string | null }[] = [];
  for (const t of tracks) {
    if (!t) continue;
    const id = trackLikeId(t.title, t.artist_name ?? null);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ title: t.title, artistName: t.artist_name ?? null });
  }
  const byId = new Map<string, number>();
  if (items.length === 0) return byId;
  const states = await invoke<number[]>("get_track_like_states", { tracks: items });
  items.forEach((it, i) => byId.set(trackLikeId(it.title, it.artistName), states[i] ?? 0));
  return byId;
}

/** Patch one entry from a fetched map, preserving object identity when
 *  nothing changes (safe inside functional setState — an unchanged map pass
 *  causes no re-render). `onlyNonZero` applies likes/dislikes but never
 *  clears — the mid-session add reconcile uses it so a durable 0 can't
 *  race-revert an optimistic like on a pre-existing same-song copy. */
export function applyLikeState<T extends LikeIdentified>(
  t: T,
  byId: Map<string, number>,
  opts?: { onlyNonZero?: boolean },
): T {
  const v = byId.get(trackLikeId(t.title, t.artist_name ?? null));
  if (v == null) return t;
  if (opts?.onlyNonZero && v === 0) return t;
  return v !== t.liked ? { ...t, liked: v } : t;
}

/** applyLikeState over a list, preserving ARRAY identity when nothing
 *  changed — hand functional setState `prev => applyLikeStates(prev, byId)`
 *  and an all-no-op reconcile bails without a render. */
export function applyLikeStates<T extends LikeIdentified>(
  list: T[],
  byId: Map<string, number>,
  opts?: { onlyNonZero?: boolean },
): T[] {
  let changed = false;
  const next = list.map(t => {
    const n = applyLikeState(t, byId, opts);
    if (n !== t) changed = true;
    return n;
  });
  return changed ? next : list;
}
