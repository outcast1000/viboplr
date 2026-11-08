import { useEffect, useMemo, useState } from "react";
import type { QueueTrack } from "../types";
import type { ContextImageRequest, ContextImageResult } from "../types/plugin";
import type { InvokeInfoFetch } from "../utils/infoFetchChain";
import { contextImageTypeIds } from "../utils/trackGalleries";
import {
  gatherContextImages,
  typesSpokenForByProviders,
  type ContextImageBatch,
  type OrderedContextImageProvider,
} from "../utils/contextImages";
import { photoSlidesFrom, NOW_PLAYING_PHOTO_CAP, type PhotoSlide } from "../utils/nowPlayingArt";
import { useLatestRef } from "./useLatestRef";

interface PluginLike {
  id: string;
  status: string;
  manifest: {
    contributes?: {
      informationTypes?: Array<{ id: string; contextImages?: boolean }>;
      contextImageProviders?: Array<{ id: string }>;
    };
  };
}

interface UseNowPlayingPhotosOpts {
  track: QueueTrack | null;
  /** The Photos visualizer is picked AND a Now Playing surface is on screen.
      Nothing is fetched otherwise — each provider is a network request. */
  enabled: boolean;
  /** Context-image providers in the user's order, with their switches. */
  providers: readonly OrderedContextImageProvider[];
  invokeProvider: (pluginId: string, providerId: string, request: ContextImageRequest) => Promise<ContextImageResult>;
  invokeInfoFetch: InvokeInfoFetch;
  pluginNames?: Map<string, string>;
  pluginStates: readonly PluginLike[];
  /** Plugins finished loading — a fetch before that would find no providers
      and never ask again. */
  pluginsReady: boolean;
}

/**
 * The Photos visualizer's pictures for the playing track: every switched-on
 * context-image provider's pick for it (told the track's year, so a provider
 * can choose photos from that era), plus the old-style galleries, shown as
 * each answer lands (one slow source must not hold back the rest). Keyed to
 * the track's identity, so a track change drops the old pictures at once and
 * a late answer for the previous song is discarded.
 */
export function useNowPlayingPhotos({
  track,
  enabled,
  providers,
  invokeProvider,
  invokeInfoFetch,
  pluginNames,
  pluginStates,
  pluginsReady,
}: UseNowPlayingPhotosOpts): PhotoSlide[] {
  const title = track?.title ?? null;
  const artist = track?.artist_name ?? null;
  const album = track?.album_title ?? null;
  const albumArtist = track?.album_artist_name ?? null;
  // What the pictures are about — a metadata edit on the playing entry is a
  // different subject, a re-render of the same one is not.
  const subject = title ? JSON.stringify([title, artist, album, albumArtist]) : null;

  // String keys so a new array with the same answer doesn't restart the fetch.
  const active = useMemo(() => pluginStates.filter((p) => p.status === "active"), [pluginStates]);
  const imageTypeKey = useMemo(() => [...contextImageTypeIds(active)].sort().join(","), [active]);
  const excludeKey = useMemo(() => [...typesSpokenForByProviders(active)].sort().join(","), [active]);
  const providerKey = useMemo(
    () => providers.filter((p) => p.enabled).map((p) => p.key).join(","),
    [providers],
  );

  // Stamped with the gather run that produced it, not just the subject: a
  // re-run for the same song (Photos picked again, the view reopened) must
  // replace the whole set, so a source that no longer has pictures drops out.
  const [found, setFound] = useState<{ run: object | null; subject: string | null; batches: ContextImageBatch[] }>(
    { run: null, subject: null, batches: [] },
  );
  const trackRef = useLatestRef(track);
  const providersRef = useLatestRef(providers);
  const invokeProviderRef = useLatestRef(invokeProvider);
  const invokeRef = useLatestRef(invokeInfoFetch);
  const namesRef = useLatestRef(pluginNames);

  useEffect(() => {
    const t = trackRef.current;
    if (!enabled || !pluginsReady || !subject || !t) return;
    let cancelled = false;
    const run = {};
    const toSet = (key: string) => new Set(key ? key.split(",") : []);
    // No reset here: the render reads only batches stamped with the current
    // subject, so the previous track's pictures are already gone. A re-run for
    // the same song keeps showing the last set until its first answer, which
    // starts a fresh one; a run that finds nothing at all clears it at the end.
    gatherContextImages({
      track: t,
      purpose: "nowplaying",
      limit: NOW_PLAYING_PHOTO_CAP,
      providers: providersRef.current,
      invokeProvider: invokeProviderRef.current,
      legacy: {
        invokeInfoFetch: invokeRef.current,
        pluginNames: namesRef.current,
        imageTypeIds: toSet(imageTypeKey),
        excludeTypeIds: toSet(excludeKey),
      },
      isCancelled: () => cancelled,
      onBatch: (batch) => {
        setFound((prev) => (prev.run === run
          ? { run, subject, batches: [...prev.batches, batch] }
          : { run, subject, batches: [batch] }));
      },
      onError: (name, message) => console.error(`Photos: ${name} failed: ${message}`),
    })
      .then(() => {
        if (cancelled) return;
        setFound((prev) => (prev.run === run ? prev : { run, subject, batches: [] }));
      })
      .catch((e) => console.error("Failed to gather Now Playing photos:", e));
    return () => { cancelled = true; };
  }, [enabled, pluginsReady, subject, imageTypeKey, excludeKey, providerKey,
    trackRef, providersRef, invokeProviderRef, invokeRef, namesRef]);

  const batches = enabled && found.subject === subject ? found.batches : NO_BATCHES;
  return useMemo(() => photoSlidesFrom(batches), [batches]);
}

const NO_BATCHES: ContextImageBatch[] = [];
