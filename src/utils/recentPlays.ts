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
export type RecentPlaySource = "album" | "artist" | "tag" | "radio" | "playlist" | "track" | "mixtape";

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
  /** Where in the snapshot the play started. */
  startIndex?: number;
  ts: number;
}

const MAX_RECENT_PLAYS = 12;

/** Most tracks a snapshot holds. A longer play keeps the 100 starting where
 *  the user began — what they would have heard next. */
export const SNAPSHOT_TRACK_CAP = 100;

/** Whether a session should replay from its snapshot. */
export function replaysFromSnapshot(s: Pick<RecentPlaySession, "source" | "snapshotId">): boolean {
  return !!s.snapshotId && s.source !== "mixtape";
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
export function sessionKey(s: Pick<RecentPlaySession, "source" | "name" | "artistName" | "mixtapePath">): string {
  if (s.source === "mixtape" && s.mixtapePath) return `mixtape::${s.mixtapePath}`;
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
  }
}
