import { useEffect, useMemo, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Album, Artist, QueueTrack } from "../types";
import { isVideoTrack } from "../utils";
import {
  selectArtistAlbumHeroImages,
  selectTagTopArtistHeroImages,
  type AlbumLite,
  type TopArtistRow,
} from "../utils/selectHeroImages";
import { resolveImageUrl } from "../utils/resolveImageUrl";

const MAX_LAYERS = 4;
const STAGE_DELAY_MS = 300;

type ResolveArtist = (name: string) => string | null;
type ResolveAlbum = (title: string, artistName: string) => string | null;
type RequestArtist = (name: string) => void;
type RequestAlbum = (title: string, artistName: string) => void;

function toUrls(paths: string[]): string[] {
  return paths.map(p => resolveImageUrl(p)).filter((u): u is string => !!u);
}

function useArtistAlbumHero(
  artist: Artist | null,
  albums: Album[],
  resolveAlbum: ResolveAlbum,
  requestAlbum: RequestAlbum,
): string[] {
  // Run the selector on every render. The selector reads through `resolveAlbum`
  // into the image cache; when that cache fills in (new image arrives), the
  // parent re-renders and we need to recompute the resolved/pending split.
  // Memoizing on `[albums, artist, resolveAlbum]` would freeze us on the
  // first cache-miss snapshot — see commit history.
  const lite: AlbumLite[] = artist
    ? albums
        .filter(a => a.artist_id === artist.id && a.title)
        .map(a => ({
          id: a.id,
          title: a.title,
          year: a.year ?? null,
          artist_id: a.artist_id as number,
          artist_name: a.artist_name ?? artist.name ?? "",
        }))
    : [];

  const { resolved, pending } = artist
    ? selectArtistAlbumHeroImages(lite, artist.id, resolveAlbum, MAX_LAYERS)
    : { resolved: [] as string[], pending: [] as Array<{ title: string; artistName: string }> };

  // Stage fetches for the still-pending candidates. Keyed by the joined title
  // list so this only fires when the *set of pending titles* changes — not on
  // every render.
  const pendingKey = pending.map(p => `${p.artistName}::${p.title}`).join("|");
  useEffect(() => {
    if (pending.length === 0) return;
    const id = setTimeout(() => {
      for (const p of pending) requestAlbum(p.title, p.artistName);
    }, STAGE_DELAY_MS);
    return () => clearTimeout(id);
    // pendingKey captures the set of pending titles for stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, requestAlbum]);

  return toUrls(resolved);
}

function useSingleArtistHero(
  artistName: string | null | undefined,
  resolveArtist: ResolveArtist,
  requestArtist: RequestArtist,
): string[] {
  const path = artistName ? resolveArtist(artistName) : null;

  useEffect(() => {
    if (!artistName || path) return;
    const id = setTimeout(() => requestArtist(artistName), STAGE_DELAY_MS);
    return () => clearTimeout(id);
  }, [artistName, path, requestArtist]);

  return useMemo(() => (path ? toUrls([path]) : []), [path]);
}

function useTrackHero(
  track: QueueTrack | null,
  resolveArtist: ResolveArtist,
  requestArtist?: RequestArtist,
): string[] {
  const [frames, setFrames] = useState<string[] | null>(null);
  const lastResolvedKey = useRef<string | null>(null);

  // Video frame resolution
  useEffect(() => {
    if (!track || !isVideoTrack(track) || !track.path) {
      setFrames(null);
      lastResolvedKey.current = null;
      return;
    }
    const key = track.key;
    if (lastResolvedKey.current === key) return;
    lastResolvedKey.current = key;

    let cancelled = false;
    (async () => {
      try {
        const trackId = await invoke<number | null>("find_track_id_by_path", { path: track.path });
        if (cancelled || trackId == null) {
          if (!cancelled) setFrames([]);
          return;
        }
        const result = await invoke<{ status: string; paths?: string[] } | null>("get_video_frames", { trackId });
        if (cancelled) return;
        const paths = result?.paths ?? [];
        setFrames(paths.slice(0, MAX_LAYERS));
      } catch (e) {
        console.error("Failed to load video frames for hero:", e);
        if (!cancelled) setFrames([]);
      }
    })();
    return () => { cancelled = true; };
  }, [track]);

  // Artist fallback (used by both audio tracks and videos with no frames).
  const fallbackName = track?.artist_name ?? null;
  const fallbackPath = fallbackName ? resolveArtist(fallbackName) : null;

  // Stage a fetch for the artist image when we'll need it but don't have it yet.
  // Same staging behavior as the other hero hooks (300ms after mount).
  const needsArtistFallback = !!track && (!isVideoTrack(track) || frames?.length === 0);
  useEffect(() => {
    if (!needsArtistFallback || !fallbackName || fallbackPath || !requestArtist) return;
    const id = setTimeout(() => requestArtist(fallbackName), STAGE_DELAY_MS);
    return () => clearTimeout(id);
  }, [needsArtistFallback, fallbackName, fallbackPath, requestArtist]);

  if (!track) return [];
  if (!isVideoTrack(track)) {
    return fallbackPath ? toUrls([fallbackPath]) : [];
  }

  // Video: use frames if available, otherwise fall back to artist image
  if (frames === null) return []; // still resolving
  if (frames.length > 0) return toUrls(frames);
  return fallbackPath ? toUrls([fallbackPath]) : [];
}

function useTagTopArtistsHero(
  tagId: number | null,
  resolveArtist: ResolveArtist,
  requestArtist: RequestArtist,
): string[] {
  const [topArtists, setTopArtists] = useState<TopArtistRow[]>([]);

  useEffect(() => {
    if (tagId == null) {
      setTopArtists([]);
      return;
    }
    let cancelled = false;
    invoke<Array<[string, number]>>("get_top_artists_for_tag", { tagId, limit: MAX_LAYERS })
      .then(rows => {
        if (cancelled) return;
        setTopArtists(rows.map(([name, track_count]) => ({ name, track_count })));
      })
      .catch(e => {
        console.error("Failed to fetch top artists for tag:", e);
        if (!cancelled) setTopArtists([]);
      });
    return () => { cancelled = true; };
  }, [tagId]);

  // Run the selector on every render so cache-fill triggers re-resolution.
  // (See useArtistAlbumHero — same memoization pitfall.)
  const { resolved, pending } = selectTagTopArtistHeroImages(topArtists, resolveArtist);

  const pendingKey = pending.join("|");
  useEffect(() => {
    if (pending.length === 0) return;
    const id = setTimeout(() => {
      for (const name of pending) requestArtist(name);
    }, STAGE_DELAY_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, requestArtist]);

  return toUrls(resolved);
}

export const useDetailHeroImages = {
  artistAlbums: useArtistAlbumHero,
  singleArtist: useSingleArtistHero,
  track: useTrackHero,
  tagTopArtists: useTagTopArtistsHero,
};
