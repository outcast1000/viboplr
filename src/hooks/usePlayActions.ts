import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Album, Artist, Tag, QueueTrack } from "../types";
import type { PlaylistContext } from "./useQueue";
import { trackToQueueTrack } from "../queueEntry";
import { track as trackTelemetry } from "../telemetry";

interface PlayActionsArgs {
  playTracks: (tracks: QueueTrack[], index: number, context?: PlaylistContext | null) => number;
  enqueueTracks: (tracks: Track[]) => void;
  // Guarded append for the tail of a play session — no-ops once the queue has
  // been replaced. Must be the raw queue append, NOT the duplicate-banner
  // enqueue path (see useQueue.appendToPlaySession).
  appendToPlaySession: (gen: number, tracks: QueueTrack[]) => boolean;
  // Drives the queue panel's "filling in the rest…" indicator.
  markBackfillPending: (gen: number) => void;
  settleBackfill: (gen: number) => void;
  setPlaylistContext: (fn: (prev: PlaylistContext | null) => PlaylistContext | null) => void;
  albums: Album[];
  artists: Artist[];
  tags: Tag[];
  getAlbumImage: (title: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
  getTagImage: (name: string) => string | null;
  notify: (message: string) => void;
}

export type InfoRow = [number, string, string, string, number];

export function extractDescription(rows: InfoRow[], infoTypeId: string): string | null {
  const row = rows.find(([, typeId]) => typeId === infoTypeId);
  if (!row) return null;
  const [, , valueJson, status] = row;
  if (status !== "ok") return null;
  try {
    const parsed = JSON.parse(valueJson);
    return parsed.summary || parsed.full || null;
  } catch (e) {
    console.error(`Malformed cached "${infoTypeId}" value:`, e);
    return null;
  }
}

export function buildAlbumContext(
  album: Album | undefined,
  imagePath: string | null,
): PlaylistContext {
  return {
    name: album?.title ?? "Unknown",
    imagePath,
    source: "album",
    metadata: {
      ...(album?.artist_name ? { artist: album.artist_name } : {}),
      ...(album?.year ? { year: String(album.year) } : {}),
    },
  };
}

export function buildArtistContext(
  artist: Artist | undefined,
  imagePath: string | null,
): PlaylistContext {
  return {
    name: artist?.name ?? "Unknown",
    imagePath,
    source: "artist",
  };
}

export function buildTagContext(
  tag: Tag | undefined,
  imagePath: string | null,
): PlaylistContext {
  return {
    name: tag?.name ?? "Unknown",
    imagePath,
    source: "tag",
  };
}

// Two tracks are the same entry for backfill purposes. Paths are the queue's
// own duplicate dimension, so they win when both sides have one; otherwise fall
// back to song identity (title + artist), which is all a metadata-only
// PluginTrack carries before its stream is resolved. Keys are ignored — the
// resolved tail always arrives with fresh ones.
function sameEntry(a: QueueTrack, b: QueueTrack): boolean {
  if (a.path && b.path) return a.path === b.path;
  return a.title === b.title && (a.artist_name ?? null) === (b.artist_name ?? null);
}

// Strip the already-playing head off a resolved tail so the seed doesn't play
// twice. Only a *leading* run is dropped: "the resolved list starts with what
// we already played" is the only case we can be sure about. A later repeat of
// the same song is left alone (it's genuinely part of the source's order), and
// a tail that arrives in a different order is appended verbatim rather than
// silently reordered — the source's list is the truth once it lands.
export function dropPlayedHead(head: QueueTrack[], tail: QueueTrack[]): QueueTrack[] {
  let skip = 0;
  while (skip < head.length && skip < tail.length && sameEntry(head[skip], tail[skip])) skip++;
  return tail.slice(skip);
}

function tryEnrichFromCache(
  entityKey: string,
  infoTypeId: string,
  setPlaylistContext: PlayActionsArgs["setPlaylistContext"],
): Promise<boolean> {
  return invoke<InfoRow[]>("info_get_values_for_entity", { entityKey })
    .then(rows => {
      const desc = extractDescription(rows, infoTypeId);
      if (desc) {
        setPlaylistContext(prev => prev ? { ...prev, description: desc } : prev);
        return true;
      }
      return false;
    })
    .catch(() => false);
}

function enrichDescription(
  entityKey: string,
  infoTypeId: string,
  setPlaylistContext: PlayActionsArgs["setPlaylistContext"],
) {
  tryEnrichFromCache(entityKey, infoTypeId, setPlaylistContext).then(found => {
    if (found) return;
    // Bio may not be cached yet (lazy-loaded by info sections). Retry after a delay.
    setTimeout(() => tryEnrichFromCache(entityKey, infoTypeId, setPlaylistContext), 3000);
  });
}

/** A play whose first track(s) are known up front and whose remainder resolves
 *  asynchronously. See `playWithBackfill`. */
export interface BackfillPlay {
  /** Plays immediately. Must be the true start of the list, in order. */
  head: QueueTrack[];
  context?: PlaylistContext | null;
  /** The full list (head included or not — the head is de-duped either way). */
  resolveTail: () => Promise<QueueTrack[]>;
  /** Toast shown when the tail fails or comes back empty. */
  tailErrorMessage?: string;
}

function entityImage(kind: "album" | "artist", name: string, artistName: string | null): Promise<string | null> {
  return invoke<string | null>("get_entity_image", { kind, name, artistName }).catch(e => {
    console.error(`Failed to resolve ${kind} image for radio cover:`, e);
    return null;
  });
}

// Resolve a radio station's banner cover after playback has started and patch
// it into the live context (album image, then artist image). Guarded on the
// context still being that station: if the user has since played something
// else, a late-arriving cover must not repaint someone else's banner.
async function enrichRadioCover(
  seedTrack: Track | undefined,
  contextName: string,
  setPlaylistContext: PlayActionsArgs["setPlaylistContext"],
) {
  if (!seedTrack) return;
  let cover: string | null = null;
  if (seedTrack.album_title) {
    cover = await entityImage("album", seedTrack.album_title, seedTrack.artist_name ?? null);
  }
  if (!cover && seedTrack.artist_name) {
    cover = await entityImage("artist", seedTrack.artist_name, null);
  }
  if (!cover) return;
  setPlaylistContext(prev =>
    prev && prev.source === "radio" && prev.name === contextName && !prev.imagePath
      ? { ...prev, imagePath: cover }
      : prev,
  );
}

export function usePlayActions({
  playTracks,
  enqueueTracks,
  appendToPlaySession,
  markBackfillPending,
  settleBackfill,
  setPlaylistContext,
  albums,
  artists,
  tags,
  getAlbumImage,
  getArtistImage,
  getTagImage,
  notify,
}: PlayActionsArgs) {
  const playAlbum = useCallback(async (albumId: number, opts?: { tracks?: Track[]; startIndex?: number }) => {
    const tracks = opts?.tracks ?? await invoke<Track[]>("get_tracks", { opts: { albumId } });
    if (tracks.length === 0) return;
    const album = albums.find(a => a.id === albumId);
    const albumImg = album ? getAlbumImage(album.title, album.artist_name) : null;
    playTracks(tracks, opts?.startIndex ?? 0, buildAlbumContext(album, albumImg));
    if (album?.artist_name) {
      enrichDescription(`album:${album.artist_name}:${album.title}`, "album_wiki", setPlaylistContext);
    }
  }, [playTracks, setPlaylistContext, albums, getAlbumImage]);

  const playArtist = useCallback(async (artistId: number, opts?: { tracks?: Track[]; startIndex?: number }) => {
    const tracks = opts?.tracks ?? await invoke<Track[]>("get_tracks_by_artist", { artistId });
    if (tracks.length === 0) return;
    const artist = artists.find(a => a.id === artistId);
    const artistImg = artist ? getArtistImage(artist.name) : null;
    playTracks(tracks, opts?.startIndex ?? 0, buildArtistContext(artist, artistImg));
    if (artist) {
      enrichDescription(`artist:${artist.name}`, "artist_bio", setPlaylistContext);
    }
  }, [playTracks, setPlaylistContext, artists, getArtistImage]);

  const playTag = useCallback(async (tagId: number, opts?: { tracks?: Track[]; startIndex?: number }) => {
    const tracks = opts?.tracks ?? await invoke<Track[]>("get_tracks", { opts: { tagId } });
    if (tracks.length === 0) return;
    const tag = tags.find(t => t.id === tagId);
    const tagImg = tag ? getTagImage(tag.name) : null;
    playTracks(tracks, opts?.startIndex ?? 0, buildTagContext(tag, tagImg));
  }, [playTracks, tags, getTagImage]);

  const enqueueAlbum = useCallback(async (albumId: number) => {
    try {
      const tracks = await invoke<Track[]>("get_tracks", { opts: { albumId } });
      const queueable = tracks.filter(t => t.liked !== -1);
      if (queueable.length > 0) enqueueTracks(queueable);
    } catch (e) {
      console.error("Failed to enqueue album:", e);
    }
  }, [enqueueTracks]);

  const enqueueArtist = useCallback(async (artistId: number) => {
    try {
      const tracks = await invoke<Track[]>("get_tracks_by_artist", { artistId });
      const queueable = tracks.filter(t => t.liked !== -1);
      if (queueable.length > 0) enqueueTracks(queueable);
    } catch (e) {
      console.error("Failed to enqueue artist:", e);
    }
  }, [enqueueTracks]);

  const enqueueTag = useCallback(async (tagId: number) => {
    try {
      const tracks = await invoke<Track[]>("get_tracks", { opts: { tagId } });
      const queueable = tracks.filter(t => t.liked !== -1);
      if (queueable.length > 0) enqueueTracks(queueable);
    } catch (e) {
      console.error("Failed to enqueue tag:", e);
    }
  }, [enqueueTracks]);

  // Canonical "start playing now, fill the rest in behind the music" action.
  // Use it whenever the first track(s) of a play are known up front but the
  // rest costs real time to produce (a plugin scrape, a network catalog) — the
  // user hears audio immediately instead of watching a modal.
  //
  // Only valid when the source *guarantees* the head is the start of the list
  // (a radio station's seed, a card's cached first track). For a list whose
  // order isn't known until it resolves, play it the ordinary way — starting
  // early would misrepresent the source's order.
  // Resolves with the tracks actually appended (empty when the tail failed, was
  // redundant, or arrived too late), so callers that post-process new queue
  // entries — e.g. reconciling plugin tracks against the durable like store —
  // can act on exactly what landed.
  const playWithBackfill = useCallback(async ({ head, context, resolveTail, tailErrorMessage }: BackfillPlay): Promise<QueueTrack[]> => {
    if (head.length === 0) return [];
    const gen = playTracks(head, 0, context ?? null);
    // Tell the queue panel a tail is coming, so the wait is visible for its
    // whole duration rather than only for as long as a toast lives.
    markBackfillPending(gen);
    try {
      let tail: QueueTrack[];
      try {
        tail = await resolveTail();
      } catch (e) {
        console.error("Failed to resolve the rest of the queue:", e);
        // The head keeps playing — the user only needs to know the rest is missing.
        if (tailErrorMessage) notify(tailErrorMessage);
        return [];
      }
      if (tail.length === 0) {
        if (tailErrorMessage) notify(tailErrorMessage);
        return [];
      }
      const rest = dropPlayedHead(head, tail);
      // Stale (the user replaced or cleared the queue while we resolved) → dropped.
      return appendToPlaySession(gen, rest) ? rest : [];
    } finally {
      settleBackfill(gen);
    }
  }, [playTracks, appendToPlaySession, markBackfillPending, settleBackfill, notify]);

  // Build a radio station from a seed track and play it. Play-only (no enqueue):
  // it replaces the queue with a freshly generated station under a "Radio: …"
  // context. Tracks are mapped to QueueTracks (fresh keys, DB ids stripped).
  const startRadio = useCallback(async (seed: { title: string; artistName: string | null; coverPath: string | null }) => {
    if (!seed.title) return;
    try {
      const tracks = await invoke<Track[]>("build_radio_for_track", {
        seedTitle: seed.title,
        seedArtist: seed.artistName,
        targetCount: 30,
      });
      if (tracks.length === 0) {
        // Seed isn't in the library, so there's nothing to play or seed from.
        notify(`Couldn't start radio — "${seed.title}" isn't in your library.`);
        return;
      }
      // Anonymous: a station was started. Radio is always track-seeded here
      // (build_radio_for_track), so there's no meaningful seed_kind to send.
      trackTelemetry("radio_started");
      const queueTracks = tracks.map(trackToQueueTrack);
      playTracks(queueTracks, 0, {
        name: `Radio: ${seed.title}`,
        imagePath: seed.coverPath ?? null,
        source: "radio",
      });
      // Resolve the queue banner's cover *after* playback starts and patch it
      // in, the way enrichDescription does — it's decoration, and two
      // get_entity_image round-trips ahead of the first note is latency the
      // user hears. Callers may pass one (the queue track's image_url, a Home
      // station's resolved cover); when they don't (library track context
      // menu), derive it from the seed track's album image, falling back to the
      // artist image — same chain Home uses.
      if (!seed.coverPath) {
        void enrichRadioCover(tracks[0], `Radio: ${seed.title}`, setPlaylistContext);
      }
      // Play whatever we found (even just the seed), but let the user know when
      // the station is small rather than silently playing one or two tracks.
      if (tracks.length < 10) {
        notify(`Radio: only found ${tracks.length} ${tracks.length === 1 ? "track" : "tracks"} similar to "${seed.title}".`);
      } else {
        notify(`Radio started · ${tracks.length} tracks`);
      }
    } catch (e) {
      console.error("Failed to start radio:", e);
      notify("Failed to start radio.");
    }
  }, [playTracks, setPlaylistContext, notify]);

  return { playAlbum, playArtist, playTag, enqueueAlbum, enqueueArtist, enqueueTag, startRadio, playWithBackfill };
}
