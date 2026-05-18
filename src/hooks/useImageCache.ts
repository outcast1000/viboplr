import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export function imageCacheKey(kind: "artist" | "album" | "tag", name: string, artistName?: string | null): string {
  if (kind === "album") {
    return `album:${(artistName ?? "").toLowerCase()}:${name.toLowerCase()}`;
  }
  return `${kind}:${name.toLowerCase()}`;
}

export interface UseImageCacheReturn {
  getImage: (name: string, artistName?: string | null) => string | null;
  invalidate: (name: string, artistName?: string | null) => void;
  requestFetch: (name: string, artistName?: string | null) => void;
  clearAllFailures: () => void;
}

export function useImageCache(
  kind: "artist" | "album" | "tag",
): UseImageCacheReturn {
  const [cache, setCache] = useState<Record<string, string | null>>({});
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const inFlight = useRef(new Set<string>());

  const getImage = useCallback((name: string, artistName?: string | null): string | null => {
    const key = imageCacheKey(kind, name, artistName);

    if (key in cacheRef.current) {
      return cacheRef.current[key];
    }

    if (inFlight.current.has(key)) {
      return null;
    }

    inFlight.current.add(key);

    invoke<string | null>("get_entity_image", { kind, name, artistName: artistName ?? null })
      .then((path) => {
        setCache((prev) => ({ ...prev, [key]: path }));
        if (path === null) {
          // No image on disk — trigger a fetch
          if (kind === "artist") {
            invoke("fetch_artist_image", { artistName: name }).catch(console.error);
          } else if (kind === "album") {
            invoke("fetch_album_image", { albumTitle: name, artistName: artistName ?? null }).catch(console.error);
          } else if (kind === "tag") {
            invoke("fetch_tag_image", { tagName: name }).catch(console.error);
          }
        }
      })
      .catch((err) => {
        console.error(`Failed to get ${kind} image for "${name}":`, err);
        setCache((prev) => ({ ...prev, [key]: null }));
      })
      .finally(() => {
        inFlight.current.delete(key);
      });

    return null;
  }, [kind]);

  const invalidate = useCallback((name: string, artistName?: string | null) => {
    const key = imageCacheKey(kind, name, artistName);
    inFlight.current.delete(key);
    setCache((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, [kind]);

  const requestFetch = useCallback((name: string, artistName?: string | null) => {
    const key = imageCacheKey(kind, name, artistName);
    inFlight.current.delete(key);
    setCache((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    if (kind === "artist") {
      invoke("fetch_artist_image", { artistName: name }).catch(console.error);
    } else if (kind === "album") {
      invoke("fetch_album_image", { albumTitle: name, artistName: artistName ?? null }).catch(console.error);
    } else if (kind === "tag") {
      invoke("fetch_tag_image", { tagName: name }).catch(console.error);
    }
  }, [kind]);

  const clearAllFailures = useCallback(() => {
    inFlight.current = new Set();
    setCache({});
  }, []);

  // Listen for image-ready and image-error events
  useEffect(() => {
    const readyEvent = `${kind}-image-ready`;
    const errorEvent = `${kind}-image-error`;

    const unlistenReady = listen<Record<string, unknown>>(readyEvent, (event) => {
      const path = event.payload.path as string;
      let key: string;

      if (kind === "artist") {
        key = imageCacheKey("artist", event.payload.name as string);
      } else if (kind === "album") {
        const title = event.payload.title as string;
        const artist = event.payload.artist_name as string | null;
        key = imageCacheKey("album", title, artist);
      } else {
        key = imageCacheKey("tag", event.payload.name as string);
      }

      setCache((prev) => ({ ...prev, [key]: path }));
    });

    const unlistenError = listen<Record<string, unknown>>(errorEvent, (event) => {
      let key: string;

      if (kind === "artist") {
        key = imageCacheKey("artist", event.payload.name as string);
      } else if (kind === "album") {
        const title = event.payload.title as string;
        const artist = event.payload.artist_name as string | null;
        key = imageCacheKey("album", title, artist);
      } else {
        key = imageCacheKey("tag", event.payload.name as string);
      }

      setCache((prev) => ({ ...prev, [key]: null }));
    });

    return () => {
      unlistenReady.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, [kind]);

  return { getImage, invalidate, requestFetch, clearAllFailures };
}
