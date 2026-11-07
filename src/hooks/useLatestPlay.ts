// Latest play — the Home shelf's cards — and the queue's Back / Forward
// history, which are one list (queue.md "Queue History").
//
// Every queue-replacing play is recorded as a card holding a snapshot of what
// it played. When a queue is replaced, its card is rewritten as it was LEFT:
// the tracks (with the user's edits and auto-continue's additions), the entry
// it was on and how far into it. A cursor — the key of the card the live
// queue is — moves through the cards with Back / Forward without reordering
// them; a new play moves the card it replaced up next to itself. Clicking a
// card on Home goes to it the same way and resumes where it was left.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { store } from "../store";
import type { QueueTrack, Album, Artist, Tag } from "../types";
import { buildManifest, tracksFromManifest, contextFromManifest, type Manifest } from "../mainPlaylist";
import {
  buildPlaySession, buildMixtapeSession, buildQueueSession, bumpPlaySession, recordPlaySession, sessionKey,
  sessionTrack, snapshotFor, asLeftSnapshot, newSnapshotId, snapshotIdsOf, droppedSnapshotIds,
  replaysFromSnapshot, replayTrack, cleanStoredSession, leftCard, backTarget, forwardTarget,
  type RecentPlaySession,
} from "../utils/recentPlays";
import { getPlaybackPosition } from "../playback/positionStore";
import type { OutgoingQueue, PlaylistContext, PlaySessionInfo, useQueue } from "./useQueue";
import type { usePlayActions } from "./usePlayActions";
import type { Notify } from "./useToasts";
import { useLatestRef } from "./useLatestRef";

/** Store key: the card the live queue is (the history cursor). */
const CURRENT_KEY = "latestPlayCurrent";

/** What the history needs from hooks App builds after it. Read at call time. */
export interface LatestPlayDeps {
  queueHook: ReturnType<typeof useQueue>;
  playActions: ReturnType<typeof usePlayActions>;
  playMixtapeFile: (path: string) => void;
  notify: Notify;
  /** Is something audibly playing right now. */
  isPlaying: () => boolean;
  /** Start `track` at `secs`. */
  playAt: (track: QueueTrack, secs: number) => void;
  /** Make `track` current at `secs` without starting it. */
  cueAt: (track: QueueTrack, secs: number) => void;
  /** Resume the current track (it is the card being gone to). */
  resume: () => void;
}

/** How a queue-replacing play is recorded, when it isn't an ordinary new
 *  play. Set right before the synchronous `playTracks` it describes:
 *  - `replay`: a card being played again without its snapshot (a rebuild) —
 *    it moves to the front and keeps what it holds;
 *  - `mixtape`: a `.mixtape` the user opened — its card points at the file. */
export type LatestPlayDirective =
  | { kind: "replay"; session: RecentPlaySession; dropSnapshot?: boolean }
  | { kind: "mixtape"; path: string; title: string };

export function useLatestPlay(
  restoredRef: React.RefObject<boolean>,
  depsRef: React.RefObject<LatestPlayDeps | null>,
) {
  // The cards, loaded from the store on mount, written on each change.
  const recentPlaysRef = useRef<RecentPlaySession[]>([]);
  // The same list as state, for the Home shelf (null until read from the store).
  const [recentPlays, setRecentPlays] = useState<RecentPlaySession[] | null>(null);
  // The cursor: the card the live queue is, null for a queue no card holds
  // (built by hand, emptied). State for the Back / Forward buttons.
  const currentKeyRef = useRef<string | null>(null);
  const [currentKey, setCurrentKeyState] = useState<string | null>(null);
  const directiveRef = useRef<LatestPlayDirective | null>(null);
  // Serializes recording. A snapshot write takes a moment (it may resize a
  // cover), so without a queue a quick second play could record before the
  // first, and a card could be rewritten before it was recorded.
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  // A play that fills in after it starts (playWithBackfill) is recorded once
  // it has filled, or as it was left if it is replaced first. Held here.
  const pendingFillRef = useRef<{ gen: number; startIndex: number; context: PlaylistContext | null; tracks: QueueTrack[]; ts: number } | null>(null);

  const setCurrentKey = useCallback((key: string | null) => {
    if (currentKeyRef.current === key) return;
    currentKeyRef.current = key;
    setCurrentKeyState(key);
    store.set(CURRENT_KEY, key).catch((e) => console.error("Failed to persist the Latest play cursor:", e));
  }, []);

  // Commit a new list, then delete the snapshot files of cards that left it
  // (evicted, replaced by a newer play of the same thing, or rewritten as left).
  const commit = useCallback((update: (prev: RecentPlaySession[]) => RecentPlaySession[]) => {
    const prev = recentPlaysRef.current;
    const next = update(prev);
    if (next === prev) return;
    recentPlaysRef.current = next;
    setRecentPlays(next);
    store.set("recentPlaySessions", next).catch((e) => console.error("Failed to persist recentPlaySessions:", e));
    const dropped = droppedSnapshotIds(prev, next);
    if (dropped.length > 0) {
      invoke("recent_play_delete", { ids: dropped }).catch((e) => console.error("Failed to delete old Latest play snapshots:", e));
    }
  }, []);

  // Each link catches its own failure: a rejected link would skip every later
  // `.then`, and Latest play would silently stop recording for the session.
  const enqueue = useCallback((step: () => void | Promise<void>) => {
    chainRef.current = chainRef.current
      .then(step)
      .catch((e) => console.error("Failed to record a Latest play:", e));
  }, []);

  // Write a snapshot file; its id, or undefined when the write failed.
  const writeSnapshot = async (tracks: QueueTrack[], context: PlaylistContext | null): Promise<string | undefined> => {
    const id = newSnapshotId(Date.now());
    try {
      await invoke("recent_play_write", { id, manifest: buildManifest(tracks, context), cover: context?.imagePath ?? null });
      return id;
    } catch (e) {
      // Without a snapshot the card still replays by name / lead track.
      console.error("Failed to snapshot latest play:", e);
      return undefined;
    }
  };

  // Record a new play as a card holding exactly the tracks it played. The
  // file is written before the card that names it, so a crash in between
  // leaves only an orphan, which the startup sweep removes.
  const recordNewPlay = (tracks: QueueTrack[], startIndex: number, context: PlaylistContext | null, ts = Date.now()) => {
    const session = buildPlaySession(tracks, startIndex, context, ts);
    if (!session) return;
    const snap = snapshotFor(tracks, startIndex, session.source);
    enqueue(async () => {
      const snapshotId = snap ? await writeSnapshot(snap.tracks, context) : undefined;
      const card = snapshotId && snap ? { ...session, snapshotId, startIndex: snap.startIndex } : session;
      commit((prev) => recordPlaySession(prev, card));
    });
  };

  /** useQueue's `onPlay`: a play replaced the queue. Not for the startup restore. */
  const onPlay = (tracks: QueueTrack[], startIndex: number, context: PlaylistContext | null, session: PlaySessionInfo) => {
    // Taken before the restore guard, so a directive can never outlive its play.
    const directive = directiveRef.current;
    directiveRef.current = null;
    if (!restoredRef.current) return;
    if (directive?.kind === "replay") {
      setCurrentKey(sessionKey(directive.session));
      enqueue(() => commit((prev) => bumpPlaySession(prev, directive.session, Date.now(), { dropSnapshot: directive.dropSnapshot })));
      return;
    }
    if (directive?.kind === "mixtape") {
      const lead = tracks[startIndex] ?? tracks[0] ?? null;
      const card = buildMixtapeSession(directive.path, directive.title, lead, Date.now());
      setCurrentKey(sessionKey(card));
      enqueue(() => commit((prev) => recordPlaySession(prev, card)));
      return;
    }
    const now = Date.now();
    const built = buildPlaySession(tracks, startIndex, context, now);
    setCurrentKey(built ? sessionKey(built) : null);
    if (session.fillsLater) {
      pendingFillRef.current = { gen: session.gen, startIndex, context, tracks, ts: now };
      return;
    }
    recordNewPlay(tracks, startIndex, context, now);
  };

  /** useQueue's `onPlaySessionFilled`: a fill-later play settled. */
  const onPlaySessionFilled = (gen: number, tracks: QueueTrack[]) => {
    const pending = pendingFillRef.current;
    if (!pending || pending.gen !== gen) return;
    pendingFillRef.current = null;
    recordNewPlay(tracks, pending.startIndex, pending.context, pending.ts);
  };

  /** useQueue's `beforeReplace`: record the queue being replaced, as left,
   *  into its card — creating one for a queue no card holds yet. */
  const beforeReplace = (out: OutgoingQueue) => {
    if (!restoredRef.current) return;
    const key = currentKeyRef.current;
    const pending = pendingFillRef.current;
    pendingFillRef.current = null;
    const snap = asLeftSnapshot(out.tracks, out.index);
    if (!snap) return;
    // Read now: the replacement starts another track right after this.
    const positionSecs = Math.max(0, Math.floor(getPlaybackPosition()));
    const now = Date.now();
    // A new play goes in front (`now`); the card it replaced lands right behind
    // it. A clear leaves this card the newest. Stepping keeps the order.
    const bumpTo = out.reason === "play" ? now - 1 : out.reason === "clear" ? now : undefined;
    const track = sessionTrack(snap.tracks[snap.startIndex] ?? null);
    enqueue(async () => {
      const exists = key !== null && recentPlaysRef.current.some((p) => sessionKey(p) === key);
      // The card to rewrite: the queue's own, else the fill-later play it was,
      // else a new "Your queue" card for one built by hand.
      const fresh = exists ? null
        : pending ? buildPlaySession(out.tracks, out.index, pending.context, pending.ts)
        : buildQueueSession(out.tracks, out.index, now, newSnapshotId(now));
      if (!exists && !fresh) return;
      const cardKey = fresh ? sessionKey(fresh) : key!;
      const snapshotId = await writeSnapshot(snap.tracks, out.context);
      commit((prev) => {
        const withCard = fresh && !prev.some((p) => sessionKey(p) === cardKey) ? recordPlaySession(prev, fresh) : prev;
        return leftCard(withCard, cardKey, { snapshotId, startIndex: snap.startIndex, positionSecs, track }, bumpTo);
      });
    });
    if (out.reason === "clear") setCurrentKey(null);
  };

  // A replayed card's tracks come from storage, which holds no library ids (a
  // stored rowid may since name another track), so look them up by path — the
  // same one call queue restore makes. Without them the now-playing menu has
  // no Delete / Show in folder until the next scan. Best-effort.
  const withLibraryIds = useCallback(async (tracks: QueueTrack[]): Promise<QueueTrack[]> => {
    const paths = [...new Set(tracks.map((t) => t.path).filter((p): p is string => !!p))];
    if (paths.length === 0) return tracks;
    try {
      const idByPath = new Map(await invoke<[string, number][]>("find_track_ids_by_paths", { paths }));
      return tracks.map((t) => {
        const id = t.path ? idByPath.get(t.path) : undefined;
        return id != null ? { ...t, libraryId: id } : t;
      });
    } catch (e) {
      console.error("Failed to resolve library ids for a Latest play replay:", e);
      return tracks;
    }
  }, []);

  /**
   * Go to a card. From its snapshot it is put back as it was left and resumes
   * there (`restoreQueue` — no new play, the cards keep their order). `play`
   * starts it; without, it plays only if something is playing now (Back /
   * Forward keep a paused player paused). `fromStart` replays the play itself
   * instead: albums, artists and tags fresh from the library, radio from its
   * seed, a mixtape from its file, anything else from its snapshot's top.
   * Without a snapshot it falls back to those rebuilds, and to the lead track.
   */
  const goToCard = useCallback(async (clicked: RecentPlaySession, opts: { play?: boolean; fromStart?: boolean } = {}) => {
    const deps = depsRef.current;
    if (!deps) return;
    const { queueHook, playActions, notify } = deps;
    // The live entry for this card wins over the shelf's copy, which may be older.
    const session = recentPlaysRef.current.find((e) => sessionKey(e) === sessionKey(clicked)) ?? clicked;
    const key = sessionKey(session);
    // The live queue already is this card: nothing to put back.
    if (!opts.fromStart && key === currentKeyRef.current && queueHook.queue.length > 0) {
      if (opts.play && !deps.isPlaying()) deps.resume();
      return;
    }
    const playAsReplay = (play: () => void, dropSnapshot?: boolean) => {
      directiveRef.current = { kind: "replay", session, dropSnapshot };
      try { play(); } finally { directiveRef.current = null; }
    };
    try {
      if (session.source === "mixtape" && session.mixtapePath && (opts.fromStart || !session.snapshotId)) {
        deps.playMixtapeFile(session.mixtapePath);
        return;
      }
      const rebuilds = session.source === "album" || session.source === "artist" || session.source === "tag" || session.source === "radio";
      let snapshotFailed = false;
      if (replaysFromSnapshot(session) && session.snapshotId && !(opts.fromStart && rebuilds)) {
        try {
          const manifest = await invoke<Manifest>("recent_play_read", { id: session.snapshotId });
          const tracks = await withLibraryIds(tracksFromManifest(manifest));
          if (tracks.length > 0) {
            const saved = contextFromManifest(manifest, null);
            // A context-less selection was recorded without one; keep it that way.
            const ctx = saved || session.source === "radio"
              ? { ...(saved ?? {}), name: session.name, imagePath: session.imagePath ?? null, source: saved?.source ?? session.source }
              : null;
            const index = opts.fromStart ? 0 : Math.min(session.startIndex ?? 0, tracks.length - 1);
            const secs = opts.fromStart ? 0 : session.positionSecs ?? 0;
            const start = opts.play || deps.isPlaying();
            queueHook.restoreQueue(tracks, index, ctx, (t) => (start ? deps.playAt(t, secs) : deps.cueAt(t, secs)));
            setCurrentKey(key);
            return;
          }
          snapshotFailed = true;
        } catch (e) {
          console.error(`Failed to read the Latest play snapshot for "${session.name}":`, e);
          snapshotFailed = true;
        }
      }
      if (session.source === "album") {
        const a = await invoke<Album | null>("find_album_by_name", { title: session.name, artistName: session.artistName ?? null });
        if (a) { playActions.playAlbum(a.id); return; }
      } else if (session.source === "artist") {
        const ar = await invoke<Artist | null>("find_artist_by_name", { name: session.name });
        if (ar) { playActions.playArtist(ar.id); return; }
      } else if (session.source === "tag") {
        const t = await invoke<Tag | null>("find_tag_by_name", { name: session.name });
        if (t) { playActions.playTag(t.id); return; }
      } else if (session.source === "radio") {
        // Seed from the stored seed track when present: its artist is required to
        // re-resolve the station (and this rescues sessions saved before the seed
        // artist was captured). Fall back to the stored seed title/artist fields.
        const seedTitle = session.track?.title ?? session.seedTitle ?? null;
        const seedArtist = session.track?.artist_name ?? session.seedArtist ?? null;
        if (seedTitle) {
          await playActions.startRadio({ title: seedTitle, artistName: seedArtist, coverPath: session.imagePath ?? null });
          return;
        }
      }
      // track / playlist / queue / unresolved library entity → replay the
      // captured lead track. Still a replay of this card, not a new single-track
      // card. A new queue entry, so a fresh key (see `replayTrack`).
      const lead = session.track ? (await withLibraryIds([replayTrack(session.track)]))[0] : null;
      if (lead) { playAsReplay(() => queueHook.playTracks([lead], 0), snapshotFailed); return; }
      notify(`Couldn't replay “${session.name}”.`, { kind: "error" });
    } catch (e) {
      console.error("Failed to replay latest-play session:", e);
      notify(`Couldn't replay “${session.name}”.`, { kind: "error" });
    }
  }, [depsRef, withLibraryIds, setCurrentKey]);

  const backTo = recentPlays ? backTarget(recentPlays, currentKey) : null;
  const forwardTo = recentPlays ? forwardTarget(recentPlays, currentKey) : null;
  const targetsRef = useLatestRef({ backTo, forwardTo });
  const goBack = useCallback(() => {
    const t = targetsRef.current.backTo;
    if (t) void goToCard(t);
  }, [goToCard, targetsRef]);
  const goForward = useCallback(() => {
    const t = targetsRef.current.forwardTo;
    if (t) void goToCard(t);
  }, [goToCard, targetsRef]);

  useEffect(() => {
    (async () => {
      const stored = (await store.get<RecentPlaySession[]>("recentPlaySessions")) ?? [];
      // Cards saved before leads were stored without their queue key / rowid
      // still carry both; strip them once, and write back only if any did.
      const plays = stored.map(cleanStoredSession);
      if (plays.some((p, i) => p !== stored[i])) {
        store.set("recentPlaySessions", plays).catch((e) => console.error("Failed to persist cleaned recentPlaySessions:", e));
      }
      const current = (await store.get<string | null>(CURRENT_KEY)) ?? null;
      currentKeyRef.current = current;
      setCurrentKeyState(current);
      recentPlaysRef.current = plays;
      setRecentPlays(plays);
      // Sweep snapshot files no card names: crash orphans, a reset store.
      // Plays only record after restore, which lands well after this mount-time
      // read, so the list here is the whole set still in use.
      invoke<number>("recent_play_gc", { keep: snapshotIdsOf(plays) })
        .then((n) => { if (n > 0) console.debug(`Removed ${n} orphaned Latest play snapshot(s)`); })
        .catch((e) => console.error("Failed to clean up Latest play snapshots:", e));
    })().catch((e) => console.error("Failed to read Latest play:", e));
  }, []);

  return {
    recentPlays,
    /** The card the live queue is (the history cursor). */
    currentKey,
    directiveRef,
    onPlay, onPlaySessionFilled, beforeReplace,
    goToCard,
    backTo, forwardTo, goBack, goForward,
  };
}
