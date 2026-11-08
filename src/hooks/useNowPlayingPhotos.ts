import { useEffect, useMemo, useState } from "react";
import type { QueueTrack } from "../types";
import type { InvokeInfoFetch } from "../utils/infoFetchChain";
import { contextImageTypeIds, gatherTrackGalleries, type TrackGallery } from "../utils/trackGalleries";
import { photoSlidesFrom, type PhotoSlide } from "../utils/nowPlayingArt";
import { useLatestRef } from "./useLatestRef";

interface PluginLike {
  status: string;
  manifest: { contributes?: { informationTypes?: Array<{ id: string; contextImages?: boolean }> } };
}

interface UseNowPlayingPhotosOpts {
  track: QueueTrack | null;
  /** The Photos visualizer is picked AND a Now Playing surface is on screen.
      Nothing is fetched otherwise — each gallery is a network request. */
  enabled: boolean;
  invokeInfoFetch: InvokeInfoFetch;
  pluginNames?: Map<string, string>;
  pluginStates: readonly PluginLike[];
  /** Plugins finished loading — a fetch before that would find no providers
      and never ask again. */
  pluginsReady: boolean;
}

/**
 * The Photos visualizer's pictures for the playing track: every gallery the
 * plugins have for the song, its artist and its album, shown as they land
 * (one slow source must not hold back the rest). Keyed to the track's
 * identity, so a track change drops the old pictures at once and a late
 * answer for the previous song is discarded.
 */
export function useNowPlayingPhotos({
  track,
  enabled,
  invokeInfoFetch,
  pluginNames,
  pluginStates,
  pluginsReady,
}: UseNowPlayingPhotosOpts): PhotoSlide[] {
  const title = track?.title ?? null;
  const artist = track?.artist_name ?? null;
  const album = track?.album_title ?? null;
  const albumArtist = track?.album_artist_name ?? null;
  // What the galleries are about — a metadata edit on the playing entry is a
  // different subject, a re-render of the same one is not.
  const subject = title ? JSON.stringify([title, artist, album, albumArtist]) : null;

  // Which non-gallery types carry pictures, by the active plugins' manifests.
  // A string key so a new plugin-states array with the same answer doesn't
  // restart the fetch.
  const imageTypeKey = useMemo(
    () => [...contextImageTypeIds(pluginStates.filter((p) => p.status === "active"))].sort().join(","),
    [pluginStates],
  );

  // Stamped with the gather run that produced it, not just the subject: a
  // re-run for the same song (Photos picked again, the view reopened) must
  // replace the whole set, so a source that no longer has pictures drops out.
  const [found, setFound] = useState<{ run: object | null; subject: string | null; galleries: TrackGallery[] }>(
    { run: null, subject: null, galleries: [] },
  );
  const trackRef = useLatestRef(track);
  const invokeRef = useLatestRef(invokeInfoFetch);
  const namesRef = useLatestRef(pluginNames);

  useEffect(() => {
    const t = trackRef.current;
    if (!enabled || !pluginsReady || !subject || !t) return;
    let cancelled = false;
    const run = {};
    // No reset here: the render reads only galleries stamped with the current
    // subject, so the previous track's pictures are already gone. A re-run for
    // the same song keeps showing the last set until its first answer, which
    // starts a fresh one; a run that finds nothing at all clears it at the end.
    gatherTrackGalleries({
      track: t,
      invokeInfoFetch: invokeRef.current,
      pluginNames: namesRef.current,
      imageTypeIds: new Set(imageTypeKey ? imageTypeKey.split(",") : []),
      isCancelled: () => cancelled,
      onGallery: (gallery) => {
        setFound((prev) => (prev.run === run
          ? { run, subject, galleries: [...prev.galleries, gallery] }
          : { run, subject, galleries: [gallery] }));
      },
    })
      .then(() => {
        if (cancelled) return;
        setFound((prev) => (prev.run === run ? prev : { run, subject, galleries: [] }));
      })
      .catch((e) => console.error("Failed to gather Now Playing photos:", e));
    return () => { cancelled = true; };
  }, [enabled, pluginsReady, subject, imageTypeKey, trackRef, invokeRef, namesRef]);

  const galleries = enabled && found.subject === subject ? found.galleries : NO_GALLERIES;
  return useMemo(() => photoSlidesFrom(galleries), [galleries]);
}

const NO_GALLERIES: TrackGallery[] = [];
