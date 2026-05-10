import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Album, Artist, Tag } from "../types";
import type { PlaylistContext } from "./useQueue";

interface PlayActionsArgs {
  playTracks: (tracks: Track[], index: number, context?: PlaylistContext | null) => void;
  setPlaylistContext: (fn: (prev: PlaylistContext | null) => PlaylistContext | null) => void;
  albums: Album[];
  artists: Artist[];
  tags: Tag[];
  albumImages: Record<number, string | null>;
  artistImages: Record<number, string | null>;
  tagImages: Record<number, string | null>;
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
  setPlaylistContext,
  albums,
  artists,
  tags,
  albumImages,
  artistImages,
  tagImages,
}: PlayActionsArgs) {
  const playAlbum = useCallback(async (albumId: number, opts?: { tracks?: Track[]; startIndex?: number }) => {
    const tracks = opts?.tracks ?? await invoke<Track[]>("get_tracks", { opts: { albumId } });
    if (tracks.length === 0) return;
    const album = albums.find(a => a.id === albumId);
    const albumImg = albumImages[albumId] ?? null;
    const stamped = tracks.map(t => !t.image_url && albumImg ? { ...t, image_url: albumImg } : t);
    playTracks(stamped, opts?.startIndex ?? 0, buildAlbumContext(album, albumImg));
    if (album?.artist_name) {
      enrichDescription(`album:${album.artist_name}:${album.title}`, "album_wiki", setPlaylistContext);
    }
  }, [playTracks, setPlaylistContext, albums, albumImages]);

  const playArtist = useCallback(async (artistId: number, opts?: { tracks?: Track[]; startIndex?: number }) => {
    const tracks = opts?.tracks ?? await invoke<Track[]>("get_tracks_by_artist", { artistId });
    if (tracks.length === 0) return;
    const artist = artists.find(a => a.id === artistId);
    const artistImg = artistImages[artistId] ?? null;
    const stamped = tracks.map(t => !t.image_url && artistImg ? { ...t, image_url: artistImg } : t);
    playTracks(stamped, opts?.startIndex ?? 0, buildArtistContext(artist, artistImg));
    if (artist) {
      enrichDescription(`artist:${artist.name}`, "artist_bio", setPlaylistContext);
    }
  }, [playTracks, setPlaylistContext, artists, artistImages]);

  const playTag = useCallback(async (tagId: number, opts?: { tracks?: Track[]; startIndex?: number }) => {
    const tracks = opts?.tracks ?? await invoke<Track[]>("get_tracks", { opts: { tagId } });
    if (tracks.length === 0) return;
    const tag = tags.find(t => t.id === tagId);
    const tagImg = tagImages[tagId] ?? null;
    const stamped = tracks.map(t => !t.image_url && tagImg ? { ...t, image_url: tagImg } : t);
    playTracks(stamped, opts?.startIndex ?? 0, buildTagContext(tag, tagImg));
  }, [playTracks, tags, tagImages]);

  return { playAlbum, playArtist, playTag };
}
