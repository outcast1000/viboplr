import type { QueueTrack } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";

// How a captured play session is replayed (see App.tsx handleReplayLatestPlay).
export type RecentPlaySource = "album" | "artist" | "tag" | "radio" | "playlist" | "track";

// A single "Latest play" entry: a lightweight, re-resolvable descriptor of
// something that replaced the queue. We deliberately do NOT snapshot the played
// tracks — album/artist/tag replay by name from the current library, radio
// regenerates a fresh station, and a lone track carries just its own QueueTrack.
export interface RecentPlaySession {
  source: RecentPlaySource;
  name: string; // display title + the name we re-resolve by
  artistName?: string | null; // album/track subtitle + album resolution disambiguator
  imagePath?: string | null; // cover for the card (from the play context)
  seedTitle?: string; // radio: the seed to regenerate a fresh station from
  seedArtist?: string | null; // radio: seed artist, when known
  track?: QueueTrack | null; // fallback replay for track/playlist/unresolved sources
  ts: number;
}

const MAX_RECENT_PLAYS = 12;

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
