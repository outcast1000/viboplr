// The in-memory copy of every track like, keyed by the backend's entity_likes
// key (`trackLikeKey`). One answer to "is this song liked?" for every surface,
// library row or not — a song's like lives here once instead of on each copy
// of the song (queue entry, now-playing track, playlist row, search result).
//
// Loaded once from `list_track_likes`, then kept current from
// `entity-likes-changed` (a single write carries its key + state; a bulk
// change reloads) and from the like actions' optimistic writes. Until the
// first load lands, `lookup` answers with the caller's fallback — the copy's
// own `liked` — so nothing renders "unliked" during startup.
import { trackLikeKey } from "../likeKeys";

export interface TrackLikeEntry {
  key: string;
  liked: number;
}

type Listener = () => void;

/** What moved: some songs (a write, its revert, an event, a reload's diff), or
 *  everything at once (the first load, when every lookup stops answering its
 *  fallback). */
export type TrackLikeChange = { keys: string[] } | { all: true };
type ChangeListener = (change: TrackLikeChange) => void;

export class TrackLikeStore {
  private likes = new Map<string, number>();
  private loaded = false;
  // Writes made while a load is in flight: the load's answer can predate
  // them, so they are re-applied on top of it.
  private writesDuringLoad: Map<string, number> | null = null;
  private keyListeners = new Map<string, Set<Listener>>();
  private anyListeners = new Set<Listener>();
  private changeListeners = new Set<ChangeListener>();

  /** Whether the first load has landed. */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** The state for a key: the store's answer once loaded, else `fallback`. */
  lookupKey(key: string, fallback?: number | null): number {
    if (!this.loaded) return normalize(fallback);
    return this.likes.get(key) ?? 0;
  }

  /** What the store holds for a key, ignoring whether it has loaded — for a
   *  change listener applying a write, which must see the written value, not a
   *  caller's fallback. */
  peek(key: string): number {
    return this.likes.get(key) ?? 0;
  }

  /** The state for a song by its metadata (see `lookupKey`). */
  lookup(title: string | null | undefined, artistName: string | null | undefined, fallback?: number | null): number {
    return this.lookupKey(trackLikeKey(title, artistName), fallback);
  }

  /** Record one song's state (an optimistic write, its revert, or an event). */
  set(key: string, liked: number): void {
    const next = normalize(liked);
    this.writesDuringLoad?.set(key, next);
    const prev = this.likes.get(key) ?? 0;
    if (next === 0) this.likes.delete(key);
    else this.likes.set(key, next);
    // Before the first load every lookup answers its fallback, so a write
    // changes nothing on screen yet — but it must still notify once loaded.
    if (prev !== next || !this.loaded) this.notify(key);
    if (prev !== next) this.emitChange({ keys: [key] });
  }

  /** Replace everything with a full read from the backend. */
  replaceAll(entries: TrackLikeEntry[]): void {
    const before = this.likes;
    const wasLoaded = this.loaded;
    const next = new Map<string, number>();
    for (const e of entries) {
      const v = normalize(e.liked);
      if (v !== 0) next.set(e.key, v);
    }
    for (const [key, v] of this.writesDuringLoad ?? []) {
      if (v === 0) next.delete(key);
      else next.set(key, v);
    }
    this.likes = next;
    this.loaded = true;
    if (!wasLoaded) {
      // Every lookup switches from its fallback to the store at once.
      this.notifyAll();
      this.emitChange({ all: true });
      return;
    }
    const changed = new Set<string>();
    for (const [key, v] of next) if (before.get(key) !== v) changed.add(key);
    for (const key of before.keys()) if (!next.has(key)) changed.add(key);
    for (const key of changed) this.notify(key);
    if (changed.size > 0) this.emitChange({ keys: [...changed] });
  }

  /** Load (or reload) from the backend. Writes made meanwhile win. */
  async load(read: () => Promise<TrackLikeEntry[]>): Promise<void> {
    this.writesDuringLoad = new Map();
    try {
      this.replaceAll(await read());
    } finally {
      this.writesDuringLoad = null;
    }
  }

  /** Listen to one song's state. */
  subscribeKey(key: string, listener: Listener): () => void {
    let set = this.keyListeners.get(key);
    if (!set) {
      set = new Set();
      this.keyListeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const s = this.keyListeners.get(key);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.keyListeners.delete(key);
    };
  }

  /** Listen to every change (a list that reads many songs). */
  subscribe(listener: Listener): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  /** Listen to what changed, with the keys — for code that keeps copies of a
   *  song's `liked` in step (`useTrackLikeCopySync`). */
  onChange(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(change: TrackLikeChange): void {
    for (const l of this.changeListeners) {
      try { l(change); } catch (e) { console.error("Track like change listener failed:", e); }
    }
  }

  private notify(key: string): void {
    for (const l of this.keyListeners.get(key) ?? []) l();
    for (const l of this.anyListeners) l();
  }

  private notifyAll(): void {
    for (const set of this.keyListeners.values()) for (const l of set) l();
    for (const l of this.anyListeners) l();
  }
}

function normalize(v: number | null | undefined): number {
  return v === 1 ? 1 : v === -1 ? -1 : 0;
}

/** Anything that carries a copy of a song's like state. */
export interface LikeCopy {
  title: string;
  artist_name?: string | null;
  liked?: number;
}

/** Set `liked` on every copy `likedOf` answers for (undefined = leave it),
 *  keeping the array — and each untouched row — identical when nothing moved.
 *  Identity matters: a new queue array clears the queue's selection and
 *  schedules a queue save. */
export function applyLikedCopies<T extends LikeCopy>(
  list: T[],
  likedOf: (key: string) => number | undefined,
): T[] {
  let changed = false;
  const next = list.map((t) => {
    const v = likedOf(trackLikeKey(t.title, t.artist_name));
    if (v === undefined || v === (t.liked ?? 0)) return t;
    changed = true;
    return { ...t, liked: v };
  });
  return changed ? next : list;
}

/** The `likedOf` for a change: the written value for each moved key, or —
 *  after the first load — the store's value for every key (a missing key is a
 *  0 there, not "unchanged"). */
export function likedOfChange(store: TrackLikeStore, change: TrackLikeChange): (key: string) => number | undefined {
  if ("all" in change) return (key) => store.peek(key);
  const moved = new Map(change.keys.map((k) => [k, store.peek(k)] as const));
  return (key) => moved.get(key);
}
