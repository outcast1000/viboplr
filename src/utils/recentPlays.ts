import type { QueueTrack } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";
import { nextQueueKey } from "../queueEntry";

/** A session's lead track as stored: a QueueTrack minus its session-only
 *  identity. `key` names one entry of one live queue (a stored one comes back
 *  as a *different* entry's key next launch — the counter restarts — and the
 *  resolver cache, keyed by it, then played that entry's file under this
 *  card's title); `libraryId` is a reusable SQLite rowid. Neither is persisted
 *  anywhere else, so neither is here. */
export type SessionTrack = Omit<QueueTrack, "key" | "libraryId">;

/** A track minus its session-only identity. Takes a stored track too: a
 *  session saved before this existed still holds `key` / `libraryId`. */
function stripSessionIdentity(t: SessionTrack & { key?: unknown; libraryId?: unknown }): SessionTrack {
  const { key: _key, libraryId: _libraryId, ...rest } = t;
  return rest;
}

/** Strip a lead track down to what a session may store. */
export function sessionTrack(t: QueueTrack | null): SessionTrack | null {
  return t ? stripSessionIdentity(t) : null;
}

/** A stored session as it should be held: a session restored from the store
 *  may predate `sessionTrack`, so its lead still carries an old key and rowid,
 *  and every replay would write them back (`bumpPlaySession` keeps the entry
 *  as it is). Returns the same object when there is nothing to strip. */
export function cleanStoredSession(s: RecentPlaySession): RecentPlaySession {
  const t = s.track as (SessionTrack & { key?: unknown; libraryId?: unknown }) | null | undefined;
  if (!t || (!("key" in t) && !("libraryId" in t))) return s;
  return { ...s, track: stripSessionIdentity(t) };
}

/** A stored lead track as a NEW queue entry, with a fresh key. `libraryId`
 *  is the caller's to look up again (by path — see App's replay), since a
 *  stored rowid may since name another track. */
export function replayTrack(t: SessionTrack): QueueTrack {
  return { ...stripSessionIdentity(t), key: nextQueueKey() };
}

// How a captured play session is replayed (see App.tsx handleReplayLatestPlay).
export type RecentPlaySource = "album" | "artist" | "tag" | "radio" | "playlist" | "track" | "mixtape" | "queue";

// A single "Latest play" entry: a small descriptor of something that replaced
// the queue. Every play keeps the tracks it played in a snapshot — a
// playlist-only mixtape (`recent_play_write`, see src-tauri/src/recent_plays.rs)
// — and replays exactly those, whatever its source. A play that fills in after
// it starts (playWithBackfill) is recorded once it has filled. The by-name
// rebuild (albums, artists, tags), the radio seed and the lead track are only
// fallbacks for a card whose snapshot is missing or unreadable, or one saved
// before every play took one. A `.mixtape` the user opened is the exception:
// the file already holds the tracks and the cover, so its session points at
// the file and replays it.
export interface RecentPlaySession {
  source: RecentPlaySource;
  name: string; // display title + the name we re-resolve by
  artistName?: string | null; // album/track subtitle + album resolution disambiguator
  imagePath?: string | null; // cover for the card (from the play context)
  seedTitle?: string; // radio: seed, for the fallback when the snapshot is gone
  seedArtist?: string | null; // radio: seed artist, when known
  track?: SessionTrack | null; // fallback replay for track/playlist/unresolved sources — replay via `replayTrack`
  /** mixtape: the `.mixtape` file the play opened — replayed by opening it
   *  again, and where the card's cover is read from. */
  mixtapePath?: string;
  /** The snapshot file holding the played tracks; absent for sessions that
   *  replay by name, for sessions saved before snapshots, and when the write
   *  failed. Replay falls back as before whenever it's missing or unreadable. */
  snapshotId?: string;
  /** Where in the snapshot to pick up: where the play started, and once the
   *  queue has been left (queue history), the entry it was on then. */
  startIndex?: number;
  /** Seconds into the `startIndex` entry when the queue was left — where Back
   *  or a card click resumes. Absent for a play that was never left. */
  positionSecs?: number;
  /** queue: the card's own identity. A hand-built queue has no name to key on,
   *  and its `ts` changes when the card moves. */
  queueId?: string;
  ts: number;
}

const MAX_RECENT_PLAYS = 12;

/** Most tracks a snapshot holds. A longer play keeps the 100 starting where
 *  the user began — what they would have heard next. */
export const SNAPSHOT_TRACK_CAP = 100;

/** Tracks an "as left" snapshot keeps before the entry the queue was on —
 *  enough to step back a little without spending the cap on what was heard. */
export const AS_LEFT_LEAD_IN = 10;

/** Whether a session should replay from its snapshot. A mixtape card has one
 *  only once the queue it opened was left; until then it replays its file. */
export function replaysFromSnapshot(s: Pick<RecentPlaySession, "source" | "snapshotId">): boolean {
  return !!s.snapshotId;
}

/** The tracks to keep for a queue being left (queue history): up to the cap,
 *  starting a few entries before the one it was on. Null for an empty queue —
 *  there is nothing to come back to. */
export function asLeftSnapshot(
  tracks: QueueTrack[],
  index: number,
): { tracks: QueueTrack[]; startIndex: number } | null {
  if (tracks.length === 0) return null;
  const at = Math.min(Math.max(index, 0), tracks.length - 1);
  if (tracks.length <= SNAPSHOT_TRACK_CAP) return { tracks, startIndex: at };
  const from = Math.max(0, Math.min(at - AS_LEFT_LEAD_IN, tracks.length - SNAPSHOT_TRACK_CAP));
  return { tracks: tracks.slice(from, from + SNAPSHOT_TRACK_CAP), startIndex: at - from };
}

/** The tracks to snapshot for a play: all of it, for every play but an opened
 *  `.mixtape` (its card replays the file) and an empty one. */
export function snapshotFor(
  tracks: QueueTrack[],
  startIndex: number,
  source: RecentPlaySource,
): { tracks: QueueTrack[]; startIndex: number } | null {
  if (source === "mixtape" || tracks.length === 0) return null;
  const start = Math.min(Math.max(startIndex, 0), tracks.length - 1);
  if (tracks.length <= SNAPSHOT_TRACK_CAP) return { tracks, startIndex: start };
  return { tracks: tracks.slice(start, start + SNAPSHOT_TRACK_CAP), startIndex: 0 };
}

/** A fresh snapshot id. Becomes a file name, so it stays inside the charset the
 *  backend accepts (letters, digits, `-`, `_`). */
export function newSnapshotId(now: number, rand: () => number = Math.random): string {
  return `${now.toString(36)}-${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "0")}`;
}

/** Snapshot ids named by these sessions — what the startup sweep keeps. */
export function snapshotIdsOf(sessions: RecentPlaySession[]): string[] {
  return sessions.flatMap((s) => (s.snapshotId ? [s.snapshotId] : []));
}

/** Snapshots `prev` named that `next` no longer does — evicted from the ring,
 *  or replaced by a newer play of the same thing. Their files can be deleted. */
export function droppedSnapshotIds(prev: RecentPlaySession[], next: RecentPlaySession[]): string[] {
  const kept = new Set(snapshotIdsOf(next));
  return snapshotIdsOf(prev).filter((id) => !kept.has(id));
}

// Dedup identity: same kind + same name (+ artist for albums/tracks). Replaying
// the same album/artist/radio moves its tile to the front rather than stacking.
// A mixtape is its file, not its title: two mixtapes can share a title.
export function sessionKey(s: Pick<RecentPlaySession, "source" | "name" | "artistName" | "mixtapePath" | "queueId">): string {
  if (s.source === "mixtape" && s.mixtapePath) return `mixtape::${s.mixtapePath}`;
  if (s.source === "queue" && s.queueId) return `queue::${s.queueId}`;
  return `${s.source}::${(s.name ?? "").toLowerCase()}::${(s.artistName ?? "").toLowerCase()}`;
}

// Move-to-front ring buffer, mirroring recordVisit: drop any existing entry with
// the same key, append the newest, cap to MAX_RECENT_PLAYS (oldest dropped).
export function recordPlaySession(
  prev: RecentPlaySession[],
  entry: RecentPlaySession,
): RecentPlaySession[] {
  const key = sessionKey(entry);
  const filtered = prev.filter((e) => sessionKey(e) !== key);
  filtered.push(entry);
  if (filtered.length > MAX_RECENT_PLAYS) {
    return filtered.slice(filtered.length - MAX_RECENT_PLAYS);
  }
  return filtered;
}

// A replayed card moves to the front and keeps the tracks it already holds.
// Replaying is not a new play, so it takes no new snapshot — that would delete
// the one a card on screen still names. Prefers the live entry for the card
// (the shelf's copy may be older) and, when the replay found the snapshot
// unreadable, forgets it so the next click doesn't try it again.
export function bumpPlaySession(
  prev: RecentPlaySession[],
  replayed: RecentPlaySession,
  now: number,
  opts: { dropSnapshot?: boolean } = {},
): RecentPlaySession[] {
  const key = sessionKey(replayed);
  const next: RecentPlaySession = { ...(prev.find((e) => sessionKey(e) === key) ?? replayed), ts: now };
  if (opts.dropSnapshot) {
    delete next.snapshotId;
    delete next.startIndex;
  }
  return recordPlaySession(prev, next);
}

// The session for a `.mixtape` the user opened. No cover is stored: the one
// the play extracted sits in a temp folder emptied at the next launch, so the
// card reads it out of the file instead (`mixtape_cover`).
export function buildMixtapeSession(
  mixtapePath: string,
  title: string,
  lead: QueueTrack | null,
  now: number,
): RecentPlaySession {
  return { source: "mixtape", name: title, mixtapePath, track: sessionTrack(lead), ts: now };
}

// Strip the "Radio: " prefix the radio context adds, recovering the seed title.
function radioSeedTitle(contextName: string): string {
  return contextName.replace(/^Radio:\s*/i, "").trim();
}

// Build a session from a queue-replacing play (useQueue.playTracks). Returns null
// when there's nothing worth recording (empty play). Source comes from the play
// context; a context-less play (e.g. double-clicking a single track) is captured
// as a "track" session keyed on the lead track. Unknown/plugin contexts (saved
// or streaming playlists) are "playlist" sessions. The tracks themselves go in
// the session's snapshot (`snapshotFor`); the lead is kept as the fallback.
export function buildPlaySession(
  tracks: QueueTrack[],
  startIndex: number,
  context: PlaylistContext | null,
  now: number,
): RecentPlaySession | null {
  const lead = sessionTrack(tracks[startIndex] ?? tracks[0] ?? null);
  const source = context?.source ?? null;

  if (context && source === "album") {
    return { source: "album", name: context.name, artistName: context.metadata?.artist ?? lead?.artist_name ?? null, imagePath: context.imagePath ?? null, track: lead, ts: now };
  }
  if (context && source === "artist") {
    return { source: "artist", name: context.name, imagePath: context.imagePath ?? null, track: lead, ts: now };
  }
  if (context && source === "tag") {
    return { source: "tag", name: context.name, imagePath: context.imagePath ?? null, track: lead, ts: now };
  }
  if (context && source === "radio") {
    // build_radio_for_track returns the seed as the first track, so tracks[0] IS
    // the seed. Capture its title AND artist — the backend matches the seed on
    // title AND artist, so a null artist fails to resolve any seed that has one.
    return { source: "radio", name: context.name, seedTitle: lead?.title ?? radioSeedTitle(context.name), seedArtist: lead?.artist_name ?? null, imagePath: context.imagePath ?? null, track: lead, ts: now };
  }
  if (context && context.name) {
    return { source: "playlist", name: context.name, imagePath: context.imagePath ?? null, track: lead, ts: now };
  }
  if (!lead) return null;
  return { source: "track", name: lead.title, artistName: lead.artist_name ?? null, imagePath: lead.image_url ?? null, track: lead, ts: now };
}

// Card subtitle: artist where meaningful, else a source-type label so a radio
// tile reads differently from an album tile.
export function sessionSubtitle(s: RecentPlaySession): string {
  switch (s.source) {
    case "album": return s.artistName || "Album";
    case "artist": return "Artist";
    case "tag": return "Tag";
    case "radio": return "Radio";
    case "playlist": return "Playlist";
    case "mixtape": return "Mixtape";
    case "track": return s.artistName || "Track";
    case "queue": return "Queue";
  }
}

/** The card for a queue no play made — enqueued into an empty queue, or one
 *  restored at launch without a card — recorded when it is left, so Back can
 *  return to it. */
export function buildQueueSession(
  tracks: QueueTrack[],
  index: number,
  now: number,
  queueId: string,
): RecentPlaySession | null {
  const lead = sessionTrack(tracks[index] ?? tracks[0] ?? null);
  if (!lead) return null;
  const at = new Date(now);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return { source: "queue", name: `Your queue · ${time}`, queueId, track: lead, ts: now };
}

// ── Queue history ────────────────────────────────────────────────────────
// The Latest play cards are the queue's Back / Forward history. Their order is
// `ts`, newest first (what the shelf shows); a cursor — the key of the card the
// live queue is — moves through them. Stepping never reorders the cards; a new
// play does (`leftCard` with `bumpTo`).

/** The cards, newest first. */
export function playsByRecency(plays: RecentPlaySession[]): RecentPlaySession[] {
  return [...plays].sort((a, b) => b.ts - a.ts);
}

/** The card Back goes to: the next older one than the live queue's. With no
 *  card for the live queue (built by hand, emptied), the newest. */
export function backTarget(plays: RecentPlaySession[], currentKey: string | null): RecentPlaySession | null {
  const ordered = playsByRecency(plays);
  const i = currentKey === null ? -1 : ordered.findIndex((p) => sessionKey(p) === currentKey);
  return ordered[i + 1] ?? null;
}

/** The card Forward goes to: the next newer one. None without a card. */
export function forwardTarget(plays: RecentPlaySession[], currentKey: string | null): RecentPlaySession | null {
  if (currentKey === null) return null;
  const ordered = playsByRecency(plays);
  const i = ordered.findIndex((p) => sessionKey(p) === currentKey);
  return i > 0 ? ordered[i - 1] : null;
}

/** What a card records about the queue when it is left. */
export interface LeftState {
  /** The as-left snapshot; absent when its write failed — the card then
   *  forgets its old one too, which no longer describes where it was left. */
  snapshotId?: string;
  startIndex: number;
  positionSecs: number;
  /** The entry it was on — the fallback replay when the snapshot is gone. */
  track: SessionTrack | null;
}

/** The list with card `key` updated to the queue as it was left. `bumpTo`
 *  moves the card to that time (a new play or a clear replaced it — it was the
 *  last thing heard); stepping Back / Forward passes none and the order stays.
 *  A card no longer in the list (evicted meanwhile) leaves it unchanged. */
export function leftCard(
  plays: RecentPlaySession[],
  key: string,
  left: LeftState,
  bumpTo?: number,
): RecentPlaySession[] {
  const i = plays.findIndex((p) => sessionKey(p) === key);
  if (i < 0) return plays;
  const { snapshotId: _old, ...prev } = plays[i];
  const next: RecentPlaySession = {
    ...prev,
    ...(left.snapshotId ? { snapshotId: left.snapshotId } : {}),
    startIndex: left.startIndex,
    positionSecs: left.positionSecs,
    track: left.track ?? prev.track ?? null,
    ts: bumpTo ?? prev.ts,
  };
  const out = plays.slice();
  out[i] = next;
  return out;
}
