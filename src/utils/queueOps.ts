// Queue entry operations shared by every caller that puts tracks into the
// queue from outside the queue's own UI: the plugin playback bridge (App's
// pluginPlaybackCallbacks), the Cmd+K plugin-result actions, and the control
// API dispatcher (hooks/useControlApi.ts). Same split as hostOps.ts — the op
// owns the decisions, the callers own argument shape and responses.
//
// The decision every entry must make, and that used to be made (or not) per
// caller — duplicates (queue.md "Duplicate Detection"). Every enqueue runs
//      `findDuplicates`; the policy says who answers. `ask` raises the queue
//      panel's banner — the answer for a user gesture, including one made in a
//      plugin's own view. `skip` / `allow` answer programmatically — the
//      control API's sanctioned exception, which reports the skip count to the
//      machine that asked instead of popping a banner over a user who didn't.
// The plugin bridge used to insert with no check at all.
//
// There is no like step: a queue entry carries no like of its own, every
// heart reads the track-like store by song (frontend.md → trackLikeStore).
//
// Replacing plays (`playNow`, `playWithBackfill`) never run the duplicate
// check: they replace the queue, and a backfill tail continues a play the user
// already made (conventions.md "Play With Backfill").

import type { QueueTrack } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";
import { partitionEnqueue } from "./controlApi";

export type DuplicatePolicy = "ask" | "skip" | "allow";

export interface BackfillOpts {
  /** Plays now; empty when the first track isn't known yet (the list then
   *  replaces the queue when it lands). */
  head: QueueTrack[];
  context?: PlaylistContext | null;
  resolveTail: () => Promise<QueueTrack[]>;
  tailErrorMessage?: string;
  /** Who is building the list (a plugin's name), shown while it loads. */
  source?: string | null;
  /** The surface that started the play (a Home card). */
  originKey?: string | null;
}

/** `"end"` appends; `"next"` inserts after the playing entry; a number is an
 *  absolute queue index. */
export type QueuePosition = "end" | "next" | number;

export interface PendingDuplicates {
  all: QueueTrack[];
  duplicates: QueueTrack[];
  unique: QueueTrack[];
  /** Absolute index; undefined = append. */
  position?: number;
}

export interface QueueOpsDeps {
  playTracks: (tracks: QueueTrack[], startIndex: number, context?: PlaylistContext | null) => number;
  enqueueTracks: (tracks: QueueTrack[]) => void;
  insertAtPosition: (tracks: QueueTrack[], position: number) => void;
  findDuplicates: (tracks: QueueTrack[]) => { duplicates: QueueTrack[]; unique: QueueTrack[] };
  /** The live queue index (read at call time — "next" must not use a stale one). */
  queueIndex: () => number;
  /** usePlayActions.playWithBackfill. */
  playWithBackfill: (opts: BackfillOpts) => Promise<QueueTrack[]>;
  /** Raise the duplicate banner; the user decides what lands. */
  askAboutDuplicates: (pending: PendingDuplicates) => void;
}

export interface AddToQueueOutcome {
  /** Inserted now. 0 while the banner is waiting on the user. */
  added: number;
  /** Duplicates left out by a `skip` policy. */
  skippedDuplicates: number;
  /** `ask` found duplicates — the banner decides what lands. */
  awaitingUser: boolean;
}

/** Replace the queue and start playing. Returns the play generation. */
export function playNow(
  deps: QueueOpsDeps,
  tracks: QueueTrack[],
  opts: { startIndex?: number; context?: PlaylistContext | null } = {},
): number {
  return deps.playTracks(tracks, opts.startIndex ?? 0, opts.context);
}

function absolutePosition(position: QueuePosition, queueIndex: number): number | undefined {
  if (position === "end") return undefined;
  if (position === "next") return queueIndex + 1;
  return position;
}

/** Add to the current queue without interrupting playback. */
export function addToQueue(
  deps: QueueOpsDeps,
  tracks: QueueTrack[],
  opts: { position?: QueuePosition; duplicates: DuplicatePolicy },
): AddToQueueOutcome {
  if (tracks.length === 0) return { added: 0, skippedDuplicates: 0, awaitingUser: false };
  const at = absolutePosition(opts.position ?? "end", deps.queueIndex());
  const dup = deps.findDuplicates(tracks);
  if (opts.duplicates === "ask" && dup.duplicates.length > 0) {
    deps.askAboutDuplicates({ all: tracks, duplicates: dup.duplicates, unique: dup.unique, position: at });
    return { added: 0, skippedDuplicates: 0, awaitingUser: true };
  }
  // `ask` with no duplicates lands everything, same as `allow`.
  const { toAdd, skipped } = partitionEnqueue(tracks, dup, opts.duplicates !== "skip");
  if (toAdd.length > 0) {
    if (at === undefined) deps.enqueueTracks(toAdd);
    else deps.insertAtPosition(toAdd, at);
  }
  return { added: toAdd.length, skippedDuplicates: skipped, awaitingUser: false };
}

/** A play whose list takes time to build (see conventions.md "Play With
 *  Backfill"): a known head plays now and the rest is appended behind it; with
 *  no head the list replaces the queue once it lands. Resolves with what landed. */
export async function playWithBackfill(deps: QueueOpsDeps, opts: BackfillOpts): Promise<QueueTrack[]> {
  return deps.playWithBackfill(opts);
}
