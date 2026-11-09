import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { subscribe } from "../utils/tauriEvents";
import { save, open } from "@tauri-apps/plugin-dialog";
import type { Track, QueueTrack, PlaylistLoadResult, PlaylistEntry, QueueMode } from "../types";
import { trackToQueueEntry, queueEntryToQueueTrack, nextQueueKey, toQueueTracks } from "../queueEntry";
import { diffThumbs, flushMainPlaylist, type ThumbInfo } from "../mainPlaylist";
import { stripImageVersion } from "../utils/resolveImageUrl";
import { track as trackTelemetry } from "../telemetry";
import { nextIndex, prevIndex, randomizeOrder } from "../queueNav";
import { sameSong } from "./useLikeActions";
import { trackLikeId } from "../utils/likeReconcile";

import { useAssignRef } from "./useLatestRef";
import type { PlayOptions } from "./usePlayback";
import { isMixtapePath } from "./useFileDrop";
export interface PlaylistContext {
  name: string;
  imagePath?: string | null;
  source?: string | null;
  description?: string | null;
  metadata?: Record<string, string> | null;
  remote?: boolean;
}

/** The play session a queue-replacing play started (see useQueue's onPlay). */
export interface PlaySessionInfo {
  /** Its play generation — the token appendToPlaySession / onPlaySessionFilled carry. */
  gen: number;
  /** A head whose tail is still resolving; its full contents come later. */
  fillsLater: boolean;
}

/** A play whose list is still being built (conventions.md "Play With Backfill").
 *  While one is live, "what plays next" waits for it. */
export interface LoadingPlay {
  /** `extend`: its known first track(s) already play and the rest is appended
   *  when it lands. `switch`: nothing of it plays yet — the current queue keeps
   *  playing and the list replaces it when it lands. */
  mode: "extend" | "switch";
  /** The play session it belongs to: the one its head started (extend) or the
   *  one it will replace (switch). Every session boundary drops it. */
  gen: number;
  /** What is loading, e.g. "Radio: Teardrop". */
  name: string;
  imagePath: string | null;
  /** Who is building it (a plugin's name), when known. */
  source: string | null;
  /** The surface that started it (a Home card), so that surface can show it. */
  originKey: string | null;
  startedAt: number;
}

/** What a loading play put in the queue, handed to whoever waited on it. */
export type LoadingPlayOutcome =
  | { kind: "extended"; index: number; first: QueueTrack }
  | { kind: "nothing" };

/** What appendToPlaySession added: the queued (possibly re-keyed) tracks and
 *  the index the first one landed at. */
export interface AppendedTail {
  index: number;
  tracks: QueueTrack[];
}

/** The queue a replacement is about to throw away (queue history: its Latest
 *  play card records it as it was left). */
export interface OutgoingQueue {
  tracks: QueueTrack[];
  index: number;
  context: PlaylistContext | null;
  /** `play`: a new play (`playTracks`, `loadPlaylist`) replaces it; `clear`:
   *  emptied; `restore`: Back / Forward / a card (`restoreQueue`). */
  reason: "play" | "clear" | "restore";
}

export interface EnqueueOptions {
  /** Absolute insert index; undefined appends. */
  position?: number;
  /** Leave out tracks already in the queue (queue.md "Duplicate Detection").
   *  Only the control API asks for this — an assistant that retries a call
   *  would otherwise stack copies. A user's enqueue adds what they asked for. */
  skipDuplicates?: boolean;
}

export interface EnqueueOutcome {
  /** Placed in the queue. */
  added: number;
  /** Left out by `skipDuplicates`. */
  skippedDuplicates: number;
}

export function useQueue(
  restoredRef: React.RefObject<boolean>,
  handlePlay: (track: QueueTrack, source?: "user" | "auto", opts?: PlayOptions) => void,
  // Fired whenever a play *replaces* the queue (the "Latest play" capture point).
  // Not fired by enqueue / play-next / auto-continue, which extend the queue.
  // `session.fillsLater`: the play is a head whose tail is still resolving
  // (playWithBackfill) — its full contents arrive via `onPlaySessionFilled`.
  onPlay?: (tracks: QueueTrack[], startIndex: number, context: PlaylistContext | null, session: PlaySessionInfo) => void,
  // The track that's audibly playing right now (null when paused or stopped),
  // read at call time. Lets playTracks keep the music running when the
  // replacing list opens on the same song — see the continuation note there.
  getPlayingTrack?: () => QueueTrack | null,
  // A `fillsLater` session finished filling (its tail landed, failed, or came
  // back empty): everything the session put in the queue — the head plus the
  // tail that was appended. Not fired once the session was replaced or cleared.
  // Read at call time.
  onPlaySessionFilled?: (gen: number, tracks: QueueTrack[]) => void,
  // Every replacement — a play, a playlist load, a clear, a restore — hands the
  // queue it replaces here first, read from refs before anything changes (the
  // queue history; App records it into its Latest play card). Read at call time.
  beforeReplace?: (outgoing: OutgoingQueue) => void,
) {
  const [queue, setQueue] = useState<QueueTrack[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [queueMode, setQueueMode] = useState<QueueMode>("normal");
  const [playlistContext, setPlaylistContext] = useState<PlaylistContext | null>(null);
  const [thumbInfo, setThumbInfo] = useState<Record<string, ThumbInfo>>({});
  // Read by the thumb-diff effect below without being one of its deps — a
  // thumb-ready event would otherwise re-run the whole diff.
  const thumbInfoRef = useRef<Record<string, ThumbInfo>>({});
  useAssignRef(thumbInfoRef, thumbInfo);

  useEffect(() => {
    return subscribe<{ key: string; filename: string }>("main-playlist-thumb-ready", (event) => {
      const key = event.payload?.key;
      const filename = event.payload?.filename;
      if (!key || !filename) return;
      // Bump version to bust the WebView cache; record the backend-supplied
      // filename (the frontend never computes it — Rust's canonical_slug is the
      // single source of truth, so there's no JS slug mirror to drift).
      setThumbInfo(prev => ({ ...prev, [key]: { version: (prev[key]?.version ?? 0) + 1, filename } }));
    });
  }, []);

  // Seed thumbInfo from the restore read result (the `thumbs` field of
  // main_playlist_read — each entry is `[uri, filename]`, existence-checked and
  // named by Rust). Mirrors the event handler's version bump so the WebView
  // cache busts, and lets restored queue rows paint cached art on first render
  // without a separate async reconcile round-trip.
  const seedThumbInfo = useCallback((entries: Array<[string, string]>) => {
    if (entries.length === 0) return;
    setThumbInfo(prev => {
      const next = { ...prev };
      for (const [key, filename] of entries) {
        if (!key || !filename) continue;
        next[key] = { version: (prev[key]?.version ?? 0) + 1, filename };
      }
      return next;
    });
  }, []);

  const queueRef = useRef(queue);
  useAssignRef(queueRef, queue);
  const queueIndexRef = useRef(queueIndex);
  useAssignRef(queueIndexRef, queueIndex);
  const queueModeRef = useRef(queueMode);
  useAssignRef(queueModeRef, queueMode);
  const playlistContextRef = useRef(playlistContext);
  useAssignRef(playlistContextRef, playlistContext);
  const queuePanelRef = useRef<HTMLDivElement>(null);
  const dragIndexRef = useRef<number | null>(null);

  // Immediate ref-based drain of the debounced write below, for the
  // profile-switch flow. Disarms any pending debounce timer so the same
  // payload isn't serialized twice. Rejections propagate to the caller
  // (which aborts the switch and surfaces the error).
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushNow = useCallback((): Promise<void> => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    return flushMainPlaylist(
      restoredRef.current === true,
      queueRef.current,
      playlistContextRef.current,
      queueIndexRef.current,
      queueModeRef.current,
      invoke,
    );
  }, [restoredRef]);

  // Persist state to main-playlist folder. flushMainPlaylist is the single
  // payload builder for this write — the flush path above sends the identical
  // shape by construction, not by parallel maintenance.
  useEffect(() => {
    if (!restoredRef.current) return;
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      flushMainPlaylist(true, queue, playlistContext, queueIndex, queueMode, invoke)
        .catch(e => console.error("Failed to write main-playlist:", e));
    }, 500);
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [queue, playlistContext, queueIndex, queueMode]);

  // Cover: sync imagePath to main-playlist/cover.jpg
  const lastCoverRef = useRef<string | null>(null);
  useEffect(() => {
    if (!restoredRef.current) return;
    const img = playlistContext?.imagePath ?? null;
    if (img === lastCoverRef.current) return;
    lastCoverRef.current = img;
    if (!img) {
      invoke("main_playlist_set_cover", { source: null })
        .catch(e => console.error("main_playlist_set_cover (clear) failed:", e));
      return;
    }
    const isUrl = img.startsWith("http://") || img.startsWith("https://");
    // Plugins may append `#v=N` to local paths (cache-busting); the backend
    // treats the whole string as a filesystem path so we must strip it before
    // sending. http(s) URLs pass through unchanged.
    const cleanPath = isUrl ? null : stripImageVersion(img);
    const source = isUrl ? { url: img, path: null } : { path: cleanPath, url: null };
    invoke("main_playlist_set_cover", { source })
      .catch(e => console.error(`main_playlist_set_cover failed for ${img}:`, e));
  }, [playlistContext]);

  // Thumb diff: write/remove thumbs when the queue changes.
  //
  // No remote gate: a thumb is written for any added track that carries an
  // `image_url` (i.e. art the entity-image cache can't serve — plugin/remote
  // tracks). Library tracks have no `image_url` on the QueueTrack, so the
  // `source` check below skips them; their art resolves via the entity cache.
  const prevQueueRef = useRef<QueueTrack[]>([]);
  useEffect(() => {
    if (!restoredRef.current) { prevQueueRef.current = queue; return; }
    const { added, removed } = diffThumbs(prevQueueRef.current, queue);
    prevQueueRef.current = queue;

    // Backend slugifies the `key` param via canonical_slug → same filename it wrote.
    for (const uri of removed) {
      invoke("main_playlist_remove_thumb", { key: uri })
        .catch(e => console.error(`main_playlist_remove_thumb failed for ${uri}:`, e));
    }
    if (removed.length > 0) {
      setThumbInfo(prev => {
        const next = { ...prev };
        for (const uri of removed) delete next[uri];
        return next;
      });
    }
    for (const t of added) {
      if (!t.path) continue;
      // Already cached on disk — skip. This is what keeps **restore** from
      // firing one write per entry: `restoredRef` is set true just *before*
      // `appRestoring` flips, so by the time the restored queue is applied this
      // effect's early-return guard no longer holds and all N entries look
      // "added". They used to be skipped only incidentally, because
      // `image_url` wasn't persisted and so `source` came out null; persisting
      // it removed that accident and left N round trips that each hit
      // `set_thumb`'s `dest.exists()` early return. thumbInfo is seeded
      // synchronously with the restored queue from `main_playlist_read`'s
      // existence-checked list, so it is already populated here.
      if (thumbInfoRef.current[t.path]) continue;
      // Strip plugin-appended `#v=N` cache-buster from local paths before
      // sending to the backend (it treats the string as a filesystem path).
      const raw = t.image_url;
      const source =
        raw?.startsWith("http") ? { url: raw, path: null } :
        raw?.startsWith("file://") ? { path: stripImageVersion(raw.slice(7)), url: null } :
        raw ? { path: stripImageVersion(raw), url: null } :
        null;
      if (!source) continue;
      invoke("main_playlist_set_thumb", { key: t.path, source })
        .catch(e => console.error(`main_playlist_set_thumb failed for "${t.title}" (${t.path}, image_url=${raw}):`, e));
    }
  }, [queue, playlistContext]);

  // Auto-scroll queue panel to current track
  useEffect(() => {
    if (queueIndex >= 0) {
      requestAnimationFrame(() => {
        const list = queuePanelRef.current?.querySelector(".queue-list");
        const item = list?.querySelector(`[data-queue-index="${queueIndex}"]`) as HTMLElement | undefined;
        item?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
  }, [queueIndex]);

  // Monotonic id of the live "play session", bumped every time the queue is
  // *replaced* or cleared. An async backfill (usePlayActions.playWithBackfill)
  // captures it when it starts the head and appends only while it is still
  // current, so a slow resolve can never dump its tail into a queue the user
  // has since replaced with something else.
  const playGenRef = useRef(0);

  // The play still being built, if any (see LoadingPlay). State for the
  // queue panel and the bars; the ref (with the promise its waiters hold) for
  // the end-of-queue path, which runs from event handlers holding a stale render.
  const [loadingPlay, setLoadingPlay] = useState<LoadingPlay | null>(null);
  const loadingRef = useRef<{
    play: LoadingPlay;
    settled: Promise<LoadingPlayOutcome>;
    resolve: (outcome: LoadingPlayOutcome) => void;
  } | null>(null);
  // The queue ran out and playback is waiting for the loading play to land.
  // Not derivable from "not playing" — that is also a pause.
  const [playbackWaiting, setPlaybackWaiting] = useState(false);
  const waitingRef = useRef(false);
  // A loading play's remainder that failed to arrive: the queue panel says so
  // for as long as that session lasts.
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const onPlaySessionFilledRef = useRef(onPlaySessionFilled);
  useAssignRef(onPlaySessionFilledRef, onPlaySessionFilled);
  const beforeReplaceRef = useRef(beforeReplace);
  useAssignRef(beforeReplaceRef, beforeReplace);

  // Hand the queue about to be replaced to the history (see `beforeReplace`).
  // Refs, not state: a replacement runs from event handlers holding an old render.
  function handOver(reason: OutgoingQueue["reason"]) {
    beforeReplaceRef.current?.({
      tracks: queueRef.current,
      index: queueIndexRef.current,
      context: playlistContextRef.current,
      reason,
    });
  }

  // Whether `entry` is the song already audibly playing, so a replacement
  // opening on it keeps the music running rather than restarting it. Two
  // different files of one song (a studio cut and a live take, both "Pearl
  // Jam — Jeremy") are two recordings, not one: picking the other is "play
  // this now". Only a matching or unknown path (a metadata-only seed) counts.
  function continuesPlaying(playingNow: QueueTrack | null, entry: QueueTrack | undefined): playingNow is QueueTrack {
    return playingNow !== null && !!entry && sameSong(playingNow, entry)
      && !(playingNow.path && entry.path && playingNow.path !== entry.path);
  }
  // What the live play session itself put in the queue: the tracks playTracks
  // started plus every tail appendToPlaySession added — never the user's own
  // enqueues. Handed to onPlaySessionFilled when a backfill settles.
  const sessionTracksRef = useRef<{ gen: number; tracks: QueueTrack[] }>({ gen: 0, tracks: [] });

  // Returns the play generation of the session it just started, for callers
  // that resolve the rest of the queue asynchronously (see appendToPlaySession).
  //
  // Accepts raw library `Track`s too: every entry path converts at the door via
  // `toQueueTracks`, so `libraryId` is stamped even when the caller (a list
  // double-click, context-menu Play, play-all, the control API) didn't run
  // `trackToQueueTrack` itself — see queue.md "`key` vs `libraryId`".
  function playTracks(
    tracks: Array<Track | QueueTrack>,
    startIndex: number,
    context?: PlaylistContext | null,
    // `exactSource`: a row's play button — the starting entry plays its own
    // source only (usePlayback.handlePlay). The rest of the list doesn't.
    opts?: { fillsLater?: boolean; exactSource?: boolean },
  ): number {
    const incoming = toQueueTracks(tracks);
    // Anonymous: an intentional play + its origin (album/artist/tag/radio/
    // playlist/plugin/…), distinct from track_played which fires per track start.
    // context.source is the logical origin surface; "none" = a bare single play.
    trackTelemetry("play", { source: context?.source ?? "none", count: incoming.length });
    // Dedupe keys *within* the incoming batch so two copies of the same library
    // track don't collide as React keys (e.g. a playlist that contains a track
    // twice, or a plugin that re-emits the same item). Without this, React's
    // reconciliation produces stale DOM that looks like a "stuck" first item.
    // As in `withUniqueKeys`, the re-keyed copy keeps its `libraryId`.
    const seen = new Set<string>();
    const dedupedTracks = incoming.map(t => {
      if (!seen.has(t.key)) { seen.add(t.key); return t; }
      const fresh = nextQueueKey();
      seen.add(fresh);
      return { ...t, key: fresh };
    });
    // Continuation: when the new list opens on the very song that's already
    // audibly playing (Start Radio — core or plugin — seeds the station with
    // the current track), replace the queue *around* the music instead of
    // restarting it from zero. Only the first entry qualifies: an explicit
    // click deeper into a list is "play this now" and still restarts. The
    // entry adopts the playing copy's key (when free) so key-based identity —
    // sameSong's fast path, edit-info patching of currentTrack — keeps seeing
    // one song. The gapless preload needs no help: driveProgressMachine
    // re-checks peekNext()'s key every tick and re-arms against the new queue.
    const playingNow = startIndex === 0 && dedupedTracks.length > 0 ? getPlayingTrack?.() ?? null : null;
    const continues = continuesPlaying(playingNow, dedupedTracks[0]);
    if (continues && dedupedTracks[0].key !== playingNow.key && !seen.has(playingNow.key)) {
      dedupedTracks[0] = { ...dedupedTracks[0], key: playingNow.key };
    }
    handOver("play");
    setQueue(dedupedTracks);
    setQueueIndex(startIndex);
    if (!continues) handlePlay(dedupedTracks[startIndex], "user", { exactSource: !!opts?.exactSource });
    setPlaylistContext(context ?? null);
    endPlaySession();
    sessionTracksRef.current = { gen: playGenRef.current, tracks: dedupedTracks };
    onPlay?.(dedupedTracks, startIndex, context ?? null, { gen: playGenRef.current, fillsLater: !!opts?.fillsLater });
    return playGenRef.current;
  }

  // Put back a queue from the history (Back / Forward / a Latest play card):
  // the list as it was left, on the entry it was on. Not a new play — no
  // `onPlay` (Latest play, open Now Playing) and no telemetry. `resume` starts
  // the entry (App seeks it to where it was left, or cues it while paused);
  // it isn't called when that entry is the song already playing, which keeps
  // running — the same continuation as playTracks', at any index.
  function restoreQueue(
    tracks: QueueTrack[],
    index: number,
    context: PlaylistContext | null,
    resume: (track: QueueTrack) => void,
  ) {
    if (tracks.length === 0) return;
    const at = Math.min(Math.max(index, 0), tracks.length - 1);
    // Entries read back from a snapshot carry freshly minted keys already.
    const fresh = tracks.slice();
    const playingNow = getPlayingTrack?.() ?? null;
    const continues = continuesPlaying(playingNow, fresh[at]);
    if (continues && fresh[at].key !== playingNow.key && !fresh.some(t => t.key === playingNow.key)) {
      fresh[at] = { ...fresh[at], key: playingNow.key };
    }
    handOver("restore");
    setQueue(fresh);
    setQueueIndex(at);
    setPlaylistContext(context);
    endPlaySession();
    sessionTracksRef.current = { gen: playGenRef.current, tracks: fresh };
    if (!continues) resume(fresh[at]);
  }

  // Every queue replacement (playTracks, clearQueue, loadPlaylist, restoreQueue) ends the
  // live play session: a tail still resolving for it is now stale, and a play
  // still loading — either mode — is dropped, releasing anyone waiting on it.
  function endPlaySession() {
    playGenRef.current += 1;
    settleLoading({ kind: "nothing" });
    setLoadFailure(null);
  }

  function settleLoading(outcome: LoadingPlayOutcome) {
    const current = loadingRef.current;
    if (!current) return;
    loadingRef.current = null;
    setLoadingPlay(null);
    current.resolve(outcome);
  }

  // Start showing a play that is still being built. Belongs to the live
  // session; any other loading play is dropped (there is only ever one).
  function beginLoadingPlay(info: Omit<LoadingPlay, "gen" | "startedAt">): LoadingPlay {
    settleLoading({ kind: "nothing" });
    setLoadFailure(null);
    const play: LoadingPlay = { ...info, gen: playGenRef.current, startedAt: Date.now() };
    let resolve: (outcome: LoadingPlayOutcome) => void = () => {};
    const settled = new Promise<LoadingPlayOutcome>(r => { resolve = r; });
    loadingRef.current = { play, settled, resolve };
    setLoadingPlay(play);
    return play;
  }

  // Still the loading play, and its session still live — i.e. what it
  // resolved may still go into the queue. False once cancelled or replaced.
  function isLoadingPlayLive(play: LoadingPlay): boolean {
    return loadingRef.current?.play === play && play.gen === playGenRef.current;
  }

  // The loading play is done: its remainder landed (`outcome`), or nothing
  // did. `failure` is the message the queue panel keeps showing for an extend
  // whose remainder failed. No-op for a play that was already dropped.
  function endLoadingPlay(play: LoadingPlay, outcome: LoadingPlayOutcome, failure?: string) {
    if (loadingRef.current?.play !== play) return;
    const live = play.gen === playGenRef.current;
    settleLoading(outcome);
    if (!live) return;
    if (failure && play.mode === "extend") setLoadFailure(failure);
    if (play.mode === "extend" && sessionTracksRef.current.gen === play.gen) {
      onPlaySessionFilledRef.current?.(play.gen, sessionTracksRef.current.tracks);
    }
  }

  // The user's × on a loading play: drop it. What it resolves later is discarded.
  function cancelLoadingPlay() {
    const current = loadingRef.current;
    if (current) endLoadingPlay(current.play, { kind: "nothing" });
  }

  // The queue ran out. While a play is still loading, what plays next is its
  // first track, so wait for it: an extend's first appended track starts here,
  // a switch starts itself when it lands. Resolves true when that settled what
  // plays next (or the user moved on meanwhile); false when nothing is loading
  // or nothing landed — the caller's end-of-queue decision (auto-continue,
  // stop) is then due.
  //
  // Without this the end of a one-track head (a plugin radio seed) races the
  // station: auto-continue plays an unrelated song and the station lands
  // behind it.
  async function waitForLoadingPlay(source: "user" | "auto" = "auto"): Promise<boolean> {
    const current = loadingRef.current;
    if (!current || current.play.gen !== playGenRef.current) return false;
    // Already waiting (the track ended, then Next was pressed): the first
    // waiter decides, or the landed track would start twice.
    if (waitingRef.current) return true;
    const gen = playGenRef.current;
    const atKey = queueRef.current[queueIndexRef.current]?.key ?? null;
    waitingRef.current = true;
    setPlaybackWaiting(true);
    let outcome: LoadingPlayOutcome;
    try {
      outcome = await current.settled;
    } finally {
      waitingRef.current = false;
      setPlaybackWaiting(false);
    }
    // The queue was replaced (the switch landed, or the user played something
    // else), or the user picked another entry while we waited.
    if (gen !== playGenRef.current) return true;
    if ((queueRef.current[queueIndexRef.current]?.key ?? null) !== atKey) return true;
    if (outcome.kind === "extended") {
      // Played from the outcome, not via playNext: the append isn't committed
      // yet, so queueRef still holds the queue without it.
      setQueueIndex(outcome.index);
      handlePlay(outcome.first, source);
      return true;
    }
    // Nothing landed — but the user may have queued something meanwhile.
    return playNext(source);
  }

  // Append the tail of a play session started by `playTracks`. Returns false
  // (and appends nothing) once the queue has been replaced or cleared — those
  // tracks belong to a station the user has already moved on from.
  //
  // See conventions.md "Play With Backfill".
  function appendToPlaySession(gen: number, tracks: QueueTrack[]): AppendedTail | null {
    if (gen !== playGenRef.current || tracks.length === 0) return null;
    // Prepared here rather than inside appendTracks so a waiter plays the
    // *queued* object — withUniqueKeys may have re-keyed it, and handing
    // handlePlay the pre-key copy would give the now-playing row an identity
    // no queue entry has.
    const prepared = withUniqueKeys(toQueueTracks(tracks));
    const firstIndex = queueRef.current.length;
    setQueue(prev => [...prev, ...prepared]);
    if (sessionTracksRef.current.gen === gen) {
      sessionTracksRef.current = { gen, tracks: [...sessionTracksRef.current.tracks, ...prepared] };
    }
    return { index: firstIndex, tracks: prepared };
  }

  // By path; a metadata-only entry (no path yet — the stream resolvers find
  // one at play time) has none to compare, so it matches another path-less
  // entry by its song identity. Comparing nulls as paths made every such
  // entry a "duplicate" of every other.
  function findDuplicates<T extends { path: string | null; title: string; artist_name?: string | null }>(
    newTracks: T[],
  ): { duplicates: T[]; unique: T[] } {
    const existingPaths = new Set<string>();
    const existingSongs = new Set<string>();
    for (const t of queueRef.current) {
      if (t.path) existingPaths.add(t.path);
      else existingSongs.add(trackLikeId(t.title, t.artist_name));
    }
    const isDuplicate = (t: T) =>
      t.path ? existingPaths.has(t.path) : existingSongs.has(trackLikeId(t.title, t.artist_name));
    const duplicates = newTracks.filter(isDuplicate);
    const unique = newTracks.filter(t => !isDuplicate(t));
    return { duplicates, unique };
  }

  // Ensure every incoming track has a key not already used by the existing
  // queue or by an earlier sibling in the same batch. Adding a library track
  // that's already enqueued (or two copies of the same track in one batch)
  // would otherwise produce React key collisions, which break reconciliation
  // and leave stale DOM nodes — visible as "phantom" first items that can't
  // be dragged. Reuse the original key when free; mint a fresh `q:N` when
  // it collides.
  //
  // Only the key is replaced — `libraryId` rides along in the spread, which is
  // the whole point of it being a separate field. Back when provenance lived in
  // the `lib:N` key, re-keying copy #2 silently downgraded it to an id-less
  // entry: same song, same row, but Delete / Download / View Details behaved
  // differently depending on which copy you right-clicked.
  function withUniqueKeys(newTracks: QueueTrack[]): QueueTrack[] {
    const used = new Set(queueRef.current.map(t => t.key));
    return newTracks.map(t => {
      if (!used.has(t.key)) {
        used.add(t.key);
        return t;
      }
      const fresh = nextQueueKey();
      used.add(fresh);
      return { ...t, key: fresh };
    });
  }

  /** Add tracks to the queue without interrupting playback — at the end, or
   *  at an absolute `position`. */
  function enqueueTracks(newTracks: Array<Track | QueueTrack>, opts: EnqueueOptions = {}): EnqueueOutcome {
    const toAdd = opts.skipDuplicates ? findDuplicates(newTracks).unique : newTracks;
    const skippedDuplicates = newTracks.length - toAdd.length;
    if (toAdd.length === 0) return { added: 0, skippedDuplicates };
    const tracks = withUniqueKeys(toQueueTracks(toAdd));
    const { position } = opts;
    if (position === undefined) {
      setQueue(prev => [...prev, ...tracks]);
    } else {
      setQueue(prev => {
        const next = [...prev];
        next.splice(position, 0, ...tracks);
        return next;
      });
      setQueueIndex(prev => position <= prev ? prev + tracks.length : prev);
    }
    return { added: tracks.length, skippedDuplicates };
  }

  function playNext(source: "user" | "auto" = "user"): boolean {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const mode = queueModeRef.current;
    const next = nextIndex(mode, idx, q.length);
    if (next === null) return false;
    setQueueIndex(next);
    handlePlay(q[next], source);
    return true;
  }

  function playPrevious() {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const mode = queueModeRef.current;
    const prev = prevIndex(mode, idx, q.length);
    if (prev === null) return;
    setQueueIndex(prev);
    handlePlay(q[prev]);
  }

  // Override the display metadata of a single queue entry (title/artist/album).
  // Queue-only: the debounced main_playlist write persists it across restarts,
  // but it never touches library rows or file tags. Does not change queueIndex
  // (the entry stays in place); currentTrack propagation is the caller's job
  // (App.tsx patches currentTrack when the edited entry is the one playing).
  function updateTrackMetadata(index: number, fields: { title: string; artist_name: string | null; album_title: string | null }) {
    setQueue(prev => prev.map((t, i) => i === index ? { ...t, ...fields } : t));
  }

  // A resolve revealed the entry's real container — e.g. a plugin-scheme URI
  // with no extension (qbt://<hash>/<n>) that landed on a video file. Without
  // this the enrichment stops at currentTrack, so the queue row's video-vs-audio
  // icon (and anything else reading the entry) keeps calling it audio. Keyed,
  // not indexed: resolves are async and the row may have moved. Same-format
  // writes return the previous array so nothing re-renders. Persistence rides
  // the debounced main_playlist write, which already carries `format`.
  function patchTrackFormat(key: string, format: string) {
    setQueue(prev => {
      const i = prev.findIndex(t => t.key === key);
      if (i < 0 || prev[i].format === format) return prev;
      return prev.map((t, idx) => (idx === i ? { ...t, format } : t));
    });
  }

  // A subsonic collection's server URL changed: its entries persist the full
  // `subsonic://{host}/{id}` location, so without this every one of them would
  // stop resolving. Keeps the previous array when nothing matches.
  function rewritePathPrefix(oldPrefix: string, newPrefix: string) {
    if (oldPrefix === newPrefix) return;
    setQueue(prev => prev.some(t => t.path?.startsWith(oldPrefix))
      ? prev.map(t => t.path?.startsWith(oldPrefix) ? { ...t, path: newPrefix + t.path.slice(oldPrefix.length) } : t)
      : prev);
  }

  // A library file was replaced by a better copy and the extension changed
  // (a.mp3 → a.flac): every entry holding the old file URI follows it, or it
  // would stop resolving. Exact match, unlike rewritePathPrefix. Keeps the
  // previous array when nothing matches.
  function replaceTrackPath(oldPath: string, newPath: string, format: string | null) {
    if (oldPath === newPath) return;
    setQueue(prev => prev.some(t => t.path === oldPath)
      ? prev.map(t => t.path === oldPath ? { ...t, path: newPath, format: format ?? t.format } : t)
      : prev);
  }

  function removeFromQueue(index: number) {
    setQueue(prev => {
      const next = [...prev];
      next.splice(index, 1);
      return next;
    });
    setQueueIndex(prev => {
      if (index < prev) return prev - 1;
      if (index === prev) return Math.min(prev, queue.length - 2);
      return prev;
    });
  }

  function removeMultiple(indices: number[]) {
    const toRemove = new Set(indices);
    setQueue(prev => prev.filter((_, i) => !toRemove.has(i)));
    setQueueIndex(prev => {
      if (toRemove.has(prev)) return Math.max(0, prev - [...toRemove].filter(i => i < prev).length);
      return prev - [...toRemove].filter(i => i < prev).length;
    });
  }

  // Remove `indices` from the queue and, when the currently-playing track is
  // among them, keep playback going instead of dropping it on the floor. The
  // progression mirrors the user's mental model: play the nearest surviving
  // track AFTER the deleted one, else (Normal mode) hand off to auto-continue
  // via `fetchContinuation`, else fall back to the nearest surviving track
  // BEFORE it, else `onStop` when the queue is now empty. When the current
  // track is NOT removed this is just `removeMultiple` with index fix-up.
  async function removeAndAdvance(
    indices: number[],
    fetchContinuation: () => Promise<QueueTrack | null>,
    onStop: () => void,
  ) {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const mode = queueModeRef.current;
    const removeSet = new Set(indices);
    const survivors = q.filter((_, i) => !removeSet.has(i));
    const removedBefore = (orig: number) => indices.filter(i => i < orig).length;

    if (!removeSet.has(idx)) {
      // Current track survives — plain removal + index shift (same as removeMultiple).
      setQueue(survivors);
      setQueueIndex(prev => prev - removedBefore(prev));
      return;
    }

    let nextOrig = -1;
    for (let i = idx + 1; i < q.length; i++) { if (!removeSet.has(i)) { nextOrig = i; break; } }
    let prevOrig = -1;
    for (let i = idx - 1; i >= 0; i--) { if (!removeSet.has(i)) { prevOrig = i; break; } }

    if (nextOrig !== -1) {
      const ni = nextOrig - removedBefore(nextOrig);
      setQueue(survivors);
      setQueueIndex(ni);
      handlePlay(survivors[ni], "user");
      return;
    }

    if (mode === "normal") {
      const cont = await fetchContinuation();
      if (cont) {
        const newQueue = [...survivors, cont];
        setQueue(newQueue);
        setQueueIndex(newQueue.length - 1);
        handlePlay(cont, "user");
        return;
      }
    }

    if (prevOrig !== -1) {
      const pi = prevOrig - removedBefore(prevOrig);
      setQueue(survivors);
      setQueueIndex(pi);
      handlePlay(survivors[pi], "user");
      return;
    }

    // Nothing left to play.
    setQueue(survivors);
    setQueueIndex(survivors.length ? 0 : -1);
    onStop();
  }

  function moveToTop(indices: number[]) {
    const sorted = [...indices].sort((a, b) => a - b);
    setQueue(prev => {
      const moving = sorted.map(i => prev[i]);
      const remaining = prev.filter((_, i) => !new Set(sorted).has(i));
      return [...moving, ...remaining];
    });
    setQueueIndex(prev => {
      const indexSet = new Set(sorted);
      if (indexSet.has(prev)) return sorted.indexOf(prev);
      const shiftedBefore = sorted.filter(i => i < prev).length;
      return prev - shiftedBefore + sorted.length;
    });
  }

  function moveToBottom(indices: number[]) {
    const sorted = [...indices].sort((a, b) => a - b);
    setQueue(prev => {
      const moving = sorted.map(i => prev[i]);
      const remaining = prev.filter((_, i) => !new Set(sorted).has(i));
      return [...remaining, ...moving];
    });
    setQueueIndex(prev => {
      const indexSet = new Set(sorted);
      if (indexSet.has(prev)) {
        const remaining = queue.length - sorted.length;
        return remaining + sorted.indexOf(prev);
      }
      return prev - sorted.filter(i => i < prev).length;
    });
  }

  function moveMultiple(indices: number[], targetIndex: number) {
    const sorted = [...indices].sort((a, b) => a - b);
    const indexSet = new Set(sorted);
    setQueue(prev => {
      const moving = sorted.map(i => prev[i]);
      const remaining = prev.filter((_, i) => !indexSet.has(i));
      // Calculate insertion point in the remaining array
      let insertAt = targetIndex;
      for (const idx of sorted) {
        if (idx < targetIndex) insertAt--;
      }
      insertAt = Math.max(0, Math.min(insertAt, remaining.length));
      remaining.splice(insertAt, 0, ...moving);
      return remaining;
    });
    setQueueIndex(prev => {
      if (indexSet.has(prev)) {
        // Current track is being moved — find its new position
        const posInMoving = sorted.indexOf(prev);
        let insertAt = targetIndex;
        for (const idx of sorted) {
          if (idx < targetIndex) insertAt--;
        }
        insertAt = Math.max(0, Math.min(insertAt, queue.length - sorted.length));
        return insertAt + posInMoving;
      }
      // Current track is not being moved — count how many moved items were before/after
      const beforeOld = sorted.filter(i => i < prev).length;
      const newPosWithoutMoving = prev - beforeOld;
      let insertAt = targetIndex;
      for (const idx of sorted) {
        if (idx < targetIndex) insertAt--;
      }
      insertAt = Math.max(0, Math.min(insertAt, queue.length - sorted.length));
      if (newPosWithoutMoving < insertAt) return newPosWithoutMoving;
      return newPosWithoutMoving + sorted.length;
    });
  }

  function moveInQueue(from: number, to: number) {
    setQueue(prev => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    setQueueIndex(prev => {
      if (prev === from) return to;
      if (from < prev && to >= prev) return prev - 1;
      if (from > prev && to <= prev) return prev + 1;
      return prev;
    });
  }

  // Re-resolve every entry's cached `libraryId` from its (durable) file URI in
  // one bulk lookup. The cache is stamped at enqueue and at restore, but
  // `tracks.id` is a reusable SQLite rowid — a rescan, a sync prune, or a
  // collection removal can delete the row behind a cached id, and a later
  // insert can hand that rowid to an unrelated track, which the entry would
  // then silently address (the id being non-null, no consumer falls back). So
  // App calls this after every library mutation (scan/sync complete,
  // collection add/remove/toggle). An entry whose path no longer resolves gets
  // its id CLEARED, not kept — null means "fall back to path/metadata lookup",
  // which is the honest answer. Returns the path → id map so the caller can
  // reconcile its own copies (playback.currentTrack), or null when there was
  // nothing to do or the lookup failed (best-effort, like the restore one).
  const reconcileLibraryIds = useCallback(async (): Promise<Map<string, number> | null> => {
    const q = queueRef.current;
    const paths = [...new Set(q.map(t => t.path).filter((p): p is string => !!p))];
    if (paths.length === 0) return null;
    try {
      const pairs = await invoke<[string, number][]>("find_track_ids_by_paths", { paths });
      const idByPath = new Map(pairs);
      setQueue(prev => {
        let changed = false;
        const next = prev.map(t => {
          const id = t.path ? idByPath.get(t.path) ?? null : null;
          if ((t.libraryId ?? null) === id) return t;
          changed = true;
          return { ...t, libraryId: id };
        });
        // Preserve array identity on a no-op pass so React bails out.
        return changed ? next : prev;
      });
      return idByPath;
    } catch (e) {
      console.error("Failed to reconcile queue library ids:", e);
      return null;
    }
  }, []);

  // Only the control API clears the queue (the panel's Clear was removed:
  // Back undoes a replacement, and the history keeps what was cleared).
  function clearQueue() {
    handOver("clear");
    setQueue([]);
    setQueueIndex(-1);
    setPlaylistContext(null);
    // Ends the live play session: any in-flight backfill is now stale.
    endPlaySession();
    invoke("main_playlist_clear").catch(console.error);
  }

  function toggleQueueMode() {
    setQueueMode(prev =>
      prev === "normal" ? "repeat-all" : prev === "repeat-all" ? "repeat-one" : "normal"
    );
  }

  function randomizeQueue() {
    const q = queueRef.current;
    if (q.length < 2) return;
    const idx = queueIndexRef.current;
    const order = randomizeOrder(q.length, idx, Math.random);
    const reordered = order.map(i => q[i]);
    setQueue(reordered);
    // The current track is order[0] by construction (when idx >= 0), so it now
    // sits at index 0. Playback is NOT re-triggered — the same audio keeps
    // playing; we only renumber the queue around it.
    setQueueIndex(idx >= 0 ? 0 : -1);
  }

  function peekNext(): QueueTrack | null {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const mode = queueModeRef.current;
    const next = nextIndex(mode, idx, q.length);
    return next === null ? null : (q[next] ?? null);
  }

  function advanceIndex(): boolean {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const mode = queueModeRef.current;
    const next = nextIndex(mode, idx, q.length);
    if (next === null) return false;
    setQueueIndex(next);
    return true;
  }

  function playNextInQueue(track: Track | QueueTrack) {
    const [unique] = withUniqueKeys(toQueueTracks([track]));
    const idx = queueIndexRef.current;
    setQueue(prev => {
      const next = [...prev];
      next.splice(idx + 1, 0, unique);
      return next;
    });
  }

  function addToQueue(track: Track | QueueTrack) {
    const [unique] = withUniqueKeys(toQueueTracks([track]));
    setQueue(prev => [...prev, unique]);
  }

  function addToQueueAndPlay(track: Track | QueueTrack, source: "user" | "auto" = "user") {
    const [unique] = withUniqueKeys(toQueueTracks([track]));
    const newIndex = queueRef.current.length;
    setQueue(prev => [...prev, unique]);
    setQueueIndex(newIndex);
    handlePlay(unique, source);
  }

  /** Insert after the playing entry and start it, keeping the rest of the
   *  queue — the "Play" a `viboplr://play` link runs (utils/appLinks.ts). An
   *  empty queue (index -1) puts it at 0. Returns the entry it inserted. */
  function insertNextAndPlay(track: Track | QueueTrack): QueueTrack {
    const [unique] = withUniqueKeys(toQueueTracks([track]));
    const at = Math.min(queueIndexRef.current + 1, queueRef.current.length);
    setQueue(prev => {
      const next = [...prev];
      next.splice(at, 0, unique);
      return next;
    });
    setQueueIndex(at);
    handlePlay(unique, "user");
    return unique;
  }

  async function savePlaylist() {
    if (queueRef.current.length === 0) return;
    const filePath = await save({
      filters: [{ name: "M3U Playlist", extensions: ["m3u"] }],
    });
    if (!filePath) return;
    const entries = queueRef.current.map(t => trackToQueueEntry(t));
    await invoke("save_playlist_entries", { path: filePath, entries });
    trackTelemetry("playlist_saved", { format: "m3u" });
    const name = filePath.split(/[/\\]/).pop()?.replace(/\.m3u8?$/i, "") ?? "Playlist";
    setPlaylistContext(prev => prev ? { ...prev, name } : { name });
  }

  async function loadPlaylist(onOpenMixtape?: (path: string) => void) {
    const filePath = await open({
      filters: [{ name: "Playlist", extensions: ["m3u", "m3u8", "mixtape"] }],
      multiple: false,
    });
    if (!filePath) return;
    if (typeof filePath === "string" && isMixtapePath(filePath)) {
      onOpenMixtape?.(filePath);
      return;
    }
    const result = await invoke<PlaylistLoadResult>("load_playlist", { path: filePath });
    trackTelemetry("playlist_loaded", { format: filePath.endsWith(".m3u8") ? "m3u8" : "m3u" });
    if (result.entries.length > 0) {
      const tracks = result.entries.map((e: PlaylistEntry) =>
        queueEntryToQueueTrack({
          url: e.url,
          title: e.title,
          artist_name: e.artist_name,
          album_title: null,
          duration_secs: e.duration_secs,
          track_number: null,
          year: null,
          format: null,
        })
      );
      // An ordinary play: it ends the session, hands the old queue to the
      // history and gets a Latest play card like any other.
      playTracks(tracks, 0, { name: result.playlist_name });
    }
  }

  return {
    queue, setQueue,
    queueIndex, setQueueIndex,
    queueMode, setQueueMode,
    queuePanelRef, dragIndexRef,
    playTracks, restoreQueue, enqueueTracks, findDuplicates, appendToPlaySession,
    loadingPlay, playbackWaiting, loadFailure,
    beginLoadingPlay, isLoadingPlayLive, endLoadingPlay, cancelLoadingPlay, waitForLoadingPlay,
    playNext, playPrevious,
    removeFromQueue, removeMultiple, removeAndAdvance, updateTrackMetadata, patchTrackFormat, rewritePathPrefix, replaceTrackPath, moveInQueue, moveMultiple, moveToTop, moveToBottom, clearQueue,
    toggleQueueMode, randomizeQueue, playNextInQueue, addToQueue, addToQueueAndPlay, insertNextAndPlay,
    peekNext, advanceIndex, reconcileLibraryIds,
    playlistContext, setPlaylistContext, savePlaylist, loadPlaylist,
    thumbInfo, seedThumbInfo, flushNow,
  };
}
