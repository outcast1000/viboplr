import { useState, useCallback, useMemo, useRef, useEffect } from "react";
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

/**
 * Ask the backend worker to fetch an entity image.
 *
 * `force` is the whole reason this is one helper rather than two inlined
 * `invoke` blocks: the automatic ("I need a thumbnail") and explicit ("fetch
 * this again") paths must send different values, and when they were separate
 * copies both sent the forcing one. That cleared the backend's recorded failure
 * on every cache miss, so its 24h retry suppression never engaged.
 */
function requestBackendFetch(
  kind: "artist" | "album" | "tag",
  name: string,
  artistName: string | null | undefined,
  force: boolean,
): void {
  if (kind === "artist") {
    invoke("fetch_artist_image", { artistName: name, force }).catch(console.error);
  } else if (kind === "album") {
    invoke("fetch_album_image", { albumTitle: name, artistName: artistName ?? null, force }).catch(console.error);
  } else {
    invoke("fetch_tag_image", { tagName: name, force }).catch(console.error);
  }
}

export interface UseImageCacheReturn {
  getImage: (name: string, artistName?: string | null) => string | null;
  /**
   * Has this key's lookup finished? `getImage` returns `null` for both "there is
   * no image" and "the lookup is still in flight", which is fine for an <img>
   * that just appears late — but not for a consumer that changes its *layout or
   * text regime* on the answer, since it would commit to "no image" and then
   * flip. A settled miss is stored as an explicit `null`, so key presence is the
   * distinction. Reads the ref, so it's safe to call during render; consumers
   * re-render when the cache state lands.
   */
  isResolved: (name: string, artistName?: string | null) => boolean;
  invalidate: (name: string, artistName?: string | null) => void;
  requestFetch: (name: string, artistName?: string | null) => void;
  clearAllFailures: () => void;
  cache: Record<string, string | null>;
}

export function useImageCache(
  kind: "artist" | "album" | "tag",
): UseImageCacheReturn {
  const [cache, setCache] = useState<Record<string, string | null>>({});
  // Per-key cache-bust version, bumped whenever the underlying image file is
  // (re)written in place (invalidate / requestFetch / *-image-ready).
  const [versions, setVersions] = useState<Record<string, number>>({});
  const bumpVersion = useCallback((key: string) => {
    setVersions((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  }, []);
  const inFlight = useRef(new Set<string>());

  // getImage / isResolved identity deliberately TRACKS THE DATA (cache +
  // versions in the deps), not just `kind`. They are render-time getters, so a
  // memo'd consumer that receives one as a prop must re-render when a lookup
  // lands — a ref-reading, always-stable getter would leave it bailing on the
  // very update that makes the image available. Unmemoized consumers see no
  // difference (they re-render with their parent either way).
  const getImage = useCallback((name: string, artistName?: string | null): string | null => {
    const key = imageCacheKey(kind, name, artistName);

    if (key in cache) {
      return imageUrlWithVersion(cache[key], versions[key] ?? 0);
    }

    if (inFlight.current.has(key)) {
      return null;
    }

    inFlight.current.add(key);

    invoke<string | null>("get_entity_image", { kind, name, artistName: artistName ?? null })
      .then((path) => {
        setCache((prev) => ({ ...prev, [key]: path }));
        if (path === null) {
          // No image on disk — trigger a fetch. NOT forced: this is a surface
          // that wants a thumbnail, not a user asking to try again, so the
          // backend's 24h failure suppression must stay in effect. Forcing here
          // cleared the failure record on every miss, so an entity no provider
          // has art for was re-resolved forever.
          requestBackendFetch(kind, name, artistName, false);
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
  }, [kind, cache, versions]);

  const isResolved = useCallback((name: string, artistName?: string | null): boolean => {
    return imageCacheKey(kind, name, artistName) in cache;
  }, [kind, cache]);

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
    // Forced: an explicit "fetch this again" discards the cached file and any
    // recorded failure, which is exactly what the automatic path must not do.
    requestBackendFetch(kind, name, artistName, true);
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

  // Memoized so the object's identity also tracks the data: consumers that put
  // the whole cache object in effect/memo deps (App's retrieve:image-applied
  // listener, QueuePanel's getTrackImage) re-run on cache changes instead of on
  // every parent render.
  return useMemo(
    () => ({ getImage, isResolved, invalidate, requestFetch, clearAllFailures, cache }),
    [getImage, isResolved, invalidate, requestFetch, clearAllFailures, cache],
  );
}
