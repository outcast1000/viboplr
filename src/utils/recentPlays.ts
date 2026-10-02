import type { QueueTrack } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";

// How a captured play session is replayed (see App.tsx handleReplayLatestPlay).
export type RecentPlaySource = "album" | "artist" | "tag" | "radio" | "playlist" | "track";

// A single "Latest play" entry: a small descriptor of something that replaced
// the queue. Albums, artists and tags replay by name from the current library
// (that picks up music added since, and survives moved files). Everything else
// — radio, generated mixes, saved and plugin playlists, multi-track selections —
// can't be rebuilt by name, so its tracks are snapshotted to a playlist-only
// mixtape (`recent_play_write`, see src-tauri/src/recent_plays.rs) and replayed
// from it. A lone track needs no snapshot: it carries its own QueueTrack.
export interface RecentPlaySession {
  source: RecentPlaySource;
  name: string; // display title + the name we re-resolve by
  artistName?: string | null; // album/track subtitle + album resolution disambiguator
  imagePath?: string | null; // cover for the card (from the play context)
  seedTitle?: string; // radio: seed, for the fallback when the snapshot is gone
  seedArtist?: string | null; // radio: seed artist, when known
  track?: QueueTrack | null; // fallback replay for track/playlist/unresolved sources
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

/** Sources that replay by name from the current library, never a snapshot. */
const REBUILT_BY_NAME: ReadonlySet<RecentPlaySource> = new Set(["album", "artist", "tag"]);

/** Whether a session should replay from its snapshot. */
export function replaysFromSnapshot(s: Pick<RecentPlaySession, "source" | "snapshotId">): boolean {
  return !!s.snapshotId && !REBUILT_BY_NAME.has(s.source);
}

/** The tracks to snapshot for a play, or null when this play doesn't take one:
 *  album/artist/tag sources, and a single track (its session already holds it). */
export function snapshotFor(
  tracks: QueueTrack[],
  startIndex: number,
  source: RecentPlaySource,
): { tracks: QueueTrack[]; startIndex: number } | null {
  if (REBUILT_BY_NAME.has(source) || tracks.length <= 1) return null;
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
export function sessionKey(s: Pick<RecentPlaySession, "source" | "name" | "artistName">): string {
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

// Strip the "Radio: " prefix the radio context adds, recovering the seed title.
function radioSeedTitle(contextName: string): string {
  return contextName.replace(/^Radio:\s*/i, "").trim();
}

// Build a session from a queue-replacing play (useQueue.playTracks). Returns null
// when there's nothing worth recording (empty play). Source comes from the play
// context; a context-less play (e.g. double-clicking a single track) is captured
// as a "track" session keyed on the lead track. Unknown/plugin contexts (saved
// or streaming playlists) can't be cheaply re-resolved, so they replay their lead.
export function buildPlaySession(
  tracks: QueueTrack[],
  startIndex: number,
  context: PlaylistContext | null,
  now: number,
): RecentPlaySession | null {
  const lead = tracks[startIndex] ?? tracks[0] ?? null;
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
    case "track": return s.artistName || "Track";
  }
}
