import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { subscribe, combineUnlisten } from "../utils/tauriEvents";

export function imageCacheKey(kind: "artist" | "album" | "tag", name: string, artistName?: string | null): string {
  if (kind === "album") {
    return `album:${(artistName ?? "").toLowerCase()}:${name.toLowerCase()}`;
  }
  return `${kind}:${name.toLowerCase()}`;
}

/**
 * Append a `#v=N` cache-buster to a cached entity-image path once it has been
 * (re)fetched. Entity images are saved to a deterministic, name-derived path
 * (`entity_image.rs`), so replacing one overwrites the same filename in place —
 * the `asset://` URL never changes and the WebView keeps serving the stale
 * cached bytes (the image only updated after an app restart). Bumping the
 * version makes the URL change so the WebView reloads. `resolveImageUrl`
 * translates the `#v=N` into a `?v=N` query for the asset request; consumers
 * that need the raw filesystem path strip it via `stripImageVersion`.
 *
 * `version === 0` (never refreshed) returns the plain path, so the common case
 * is unchanged. Remote/data URLs are returned as-is (they're already unique).
 */
export function imageUrlWithVersion(path: string | null, version: number): string | null {
  if (!path) return null;
  if (version <= 0) return path;
  if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("data:")) {
    return path;
  }
  return `${path}#v=${version}`;
}

export interface UseImageCacheReturn {
  getImage: (name: string, artistName?: string | null) => string | null;
  invalidate: (name: string, artistName?: string | null) => void;
  requestFetch: (name: string, artistName?: string | null) => void;
  clearAllFailures: () => void;
  cache: Record<string, string | null>;
}

export function useImageCache(
  kind: "artist" | "album" | "tag",
): UseImageCacheReturn {
  const [cache, setCache] = useState<Record<string, string | null>>({});
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  // Per-key cache-bust version, bumped whenever the underlying image file is
  // (re)written in place (invalidate / requestFetch / *-image-ready). State so a
  // bump re-renders consumers; ref mirror so the getImage callback reads it
  // without stale-closure issues.
  const [versions, setVersions] = useState<Record<string, number>>({});
  const versionsRef = useRef(versions);
  versionsRef.current = versions;
  const bumpVersion = useCallback((key: string) => {
    setVersions((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  }, []);
  const inFlight = useRef(new Set<string>());

  const getImage = useCallback((name: string, artistName?: string | null): string | null => {
    const key = imageCacheKey(kind, name, artistName);

    if (key in cacheRef.current) {
      return imageUrlWithVersion(cacheRef.current[key], versionsRef.current[key] ?? 0);
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
    bumpVersion(key);
    setCache((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, [kind, bumpVersion]);

  const requestFetch = useCallback((name: string, artistName?: string | null) => {
    const key = imageCacheKey(kind, name, artistName);
    inFlight.current.delete(key);
    bumpVersion(key);
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
  }, [kind, bumpVersion]);

  const clearAllFailures = useCallback(() => {
    inFlight.current = new Set();
    setCache({});
    setVersions({});
  }, []);

  // Listen for image-ready and image-error events
  useEffect(() => {
    const readyEvent = `${kind}-image-ready`;
    const errorEvent = `${kind}-image-error`;

    const stopReady = subscribe<Record<string, unknown>>(readyEvent, (event) => {
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

      // A ready event means the file at this slug was (re)written — bump the
      // cache-bust version so a same-path replacement actually reloads.
      bumpVersion(key);
      setCache((prev) => ({ ...prev, [key]: path }));
    });

    const stopError = subscribe<Record<string, unknown>>(errorEvent, (event) => {
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

    return combineUnlisten(stopReady, stopError);
  }, [kind, bumpVersion]);

  return { getImage, invalidate, requestFetch, clearAllFailures, cache };
}
