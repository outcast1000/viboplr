import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Album, Artist, Tag, QueueTrack } from "../types";
import type { PlaylistContext } from "./useQueue";
import { trackToQueueTrack } from "../queueEntry";
import { track as trackTelemetry } from "../telemetry";

interface PlayActionsArgs {
  playTracks: (tracks: QueueTrack[], index: number, context?: PlaylistContext | null) => void;
  enqueueTracks: (tracks: Track[]) => void;
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
  } catch { return null; }
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

export function usePlayActions({
  playTracks,
  enqueueTracks,
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

  // Build a radio station from a seed track and play it. Play-only (no enqueue):
  // it replaces the queue with a freshly generated station under a "Radio: …"
  // context. Tracks are mapped to QueueTracks (fresh keys, DB ids stripped).
  const startRadio = useCallback(async (seed: { title: string; artistName: string | null; coverPath: string | null }) => {
    if (!seed.title) return;
    console.log(`Building radio from "${seed.title}"...`);
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
      // Resolve a cover for the queue banner. Callers may pass one (e.g. the
      // queue track's image_url, or a Home station's resolved cover); when they
      // don't (library track context menu), derive it from the seed track's
      // album image, falling back to the artist image — same chain Home uses.
      let coverPath = seed.coverPath ?? null;
      if (!coverPath) {
        const seedTrack = tracks[0];
        if (seedTrack?.album_title) {
          coverPath = await invoke<string | null>("get_entity_image", { kind: "album", name: seedTrack.album_title, artistName: seedTrack.artist_name ?? null }).catch(() => null);
        }
        if (!coverPath && seedTrack?.artist_name) {
          coverPath = await invoke<string | null>("get_entity_image", { kind: "artist", name: seedTrack.artist_name, artistName: null }).catch(() => null);
        }
      }
      const queueTracks = tracks.map(trackToQueueTrack);
      playTracks(queueTracks, 0, {
        name: `Radio: ${seed.title}`,
        imagePath: coverPath,
        source: "radio",
      });
      console.log(`Radio started · ${tracks.length} tracks`);
      // Play whatever we found (even just the seed), but let the user know when
      // the station is small rather than silently playing one or two tracks.
      if (tracks.length < 10) {
        notify(`Radio: only found ${tracks.length} ${tracks.length === 1 ? "track" : "tracks"} similar to "${seed.title}".`);
      }
    } catch (e) {
      console.error("Failed to start radio:", e);
      notify("Failed to start radio.");
    }
  }, [playTracks, notify]);

  return { playAlbum, playArtist, playTag, enqueueAlbum, enqueueArtist, enqueueTag, startRadio };
}
