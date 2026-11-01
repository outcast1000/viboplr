import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { trackLikeKey } from "../likeKeys";
import { subscribe as subscribeEvent } from "../utils/tauriEvents";
import { emitTracksLiked } from "../trackEvents";
import { useLatestRef } from "../hooks/useLatestRef";
import type { Track } from "../types";
import { TrackLikeStore, applyLikedCopies, likedOfChange, type TrackLikeEntry } from "../utils/trackLikeStore";

/** The app's one track-like store (App provides it). Optional: without a
 *  provider — a component test, a surface outside App — every heart reads the
 *  copy's own `liked`, exactly as before the store existed. */
export const TrackLikeStoreContext = createContext<TrackLikeStore | null>(null);

export function useTrackLikeStore(): TrackLikeStore | null {
  return useContext(TrackLikeStoreContext);
}

interface SongIdentity {
  title: string;
  artist_name?: string | null;
}

const noopUnsubscribe = () => {};

/** A song's like state, live. `fallback` (the copy's own `liked`) answers
 *  while there is no store or it hasn't loaded yet. Subscribes to this song's
 *  key only, so a like elsewhere doesn't re-render it. `song` null → fallback. */
export function useTrackLike(song: SongIdentity | null | undefined, fallback?: number | null): number {
  const store = useTrackLikeStore();
  const title = song?.title;
  const artist = song?.artist_name ?? null;
  const hasSong = !!song;
  const key = useMemo(() => (hasSong ? trackLikeKey(title, artist) : null), [hasSong, title, artist]);
  const subscribe = useCallback(
    (cb: () => void) => (store && key ? store.subscribeKey(key, cb) : noopUnsubscribe),
    [store, key],
  );
  const read = () => (store && key ? store.lookupKey(key, fallback) : normalize(fallback));
  return useSyncExternalStore(subscribe, read, read);
}

/** Load the store and keep it current from `entity-likes-changed`. App calls it
 *  once, next to the provider. A single write carries `{ kind, key, liked }`
 *  and is applied directly; `bulk` (or anything unrecognised) reloads. */
export function useTrackLikeStoreSync(store: TrackLikeStore): void {
  useEffect(() => {
    const reload = () =>
      store
        .load(() => invoke<TrackLikeEntry[]>("list_track_likes"))
        .catch((e) => console.error("Failed to load track likes:", e));
    reload();
    return subscribeEvent<{ kind?: string; key?: unknown; liked?: unknown }>("entity-likes-changed", (event) => {
      const p = event.payload ?? {};
      if (p.kind === "track" && typeof p.key === "string" && typeof p.liked === "number") {
        store.set(p.key, p.liked);
        return;
      }
      if (p.kind === "track" || p.kind === "bulk" || p.kind == null) reload();
    });
  }, [store]);
}

interface LikeCopyTargets {
  setLibraryTracks: Dispatch<SetStateAction<Track[]>>;
}

/** Keep every library `Track` copy's `liked` in step with the store, from one
 *  place: the library list directly, and — through a `liked` track event — the
 *  Library search results, detail-page lists and the track page. Driven by the
 *  store, so a like from any source moves them (a click, a plugin, the control
 *  API, an import), not only a click in this window.
 *
 *  Hearts don't need this (they read the store), and queue entries carry no
 *  `liked` at all. It exists for the code that decides from a library row's
 *  `liked` — skip disliked tracks on play, sort by liked — which is also what
 *  the database's own mirror column holds. */
export function useTrackLikeCopySync(store: TrackLikeStore, targets: LikeCopyTargets): void {
  const targetsRef = useLatestRef(targets);
  useEffect(() => store.onChange((change) => {
    const likedOf = likedOfChange(store, change);
    const t = targetsRef.current;
    t.setLibraryTracks((prev) => applyLikedCopies(prev, likedOf));
    emitTracksLiked(likedOf);
  }), [store, targetsRef]);
}

function normalize(v: number | null | undefined): number {
  return v === 1 ? 1 : v === -1 ? -1 : 0;
}
