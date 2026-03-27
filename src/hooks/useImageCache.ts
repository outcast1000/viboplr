import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface UseImageCacheReturn {
  images: Record<number, string | null>;
  fetchOnDemand: (entity: { id: number; name?: string; title?: string; artist_name?: string | null }) => void;
  setLocalImage: (id: number, path: string) => void;
  clearImage: (id: number) => void;
  clearAllFailures: () => void;
  setImages: React.Dispatch<React.SetStateAction<Record<number, string | null>>>;
}

export function useImageCache(
  kind: "artist" | "album" | "tag",
  addLog?: (msg: string) => void,
): UseImageCacheReturn {
  const [images, setImages] = useState<Record<number, string | null>>({});
  const fetched = useRef(new Set<number>());
  const failed = useRef(new Set<number>());
  const imagesRef = useRef(images);
  imagesRef.current = images;

  const fetchOnDemand = useCallback((entity: { id: number; name?: string; title?: string; artist_name?: string | null }) => {
    if (imagesRef.current[entity.id] !== undefined) return;
    if (fetched.current.has(entity.id)) return;
    if (failed.current.has(entity.id)) return;
    fetched.current = new Set(fetched.current).add(entity.id);

    invoke<string | null>("get_entity_image", { kind, id: entity.id }).then((path) => {
      if (path) {
        setImages((prev) => ({ ...prev, [entity.id]: path }));
      } else if (kind === "artist") {
        invoke("fetch_artist_image", { artistId: entity.id, artistName: entity.name ?? "Unknown" });
      } else if (kind === "album") {
        invoke("fetch_album_image", { albumId: entity.id, albumTitle: entity.title ?? "", artistName: entity.artist_name });
      } else if (kind === "tag") {
        invoke("fetch_tag_image", { tagId: entity.id, tagName: entity.name ?? "Unknown" });
      }
    });
  }, [kind]);

  const setLocalImage = useCallback((id: number, path: string) => {
    setImages((prev) => ({ ...prev, [id]: path }));
  }, []);

  const clearImage = useCallback((id: number) => {
    setImages((prev) => ({ ...prev, [id]: null }));
  }, []);

  const clearAllFailures = useCallback(() => {
    failed.current = new Set();
    fetched.current = new Set();
  }, []);

  // Listen for image-ready and image-error events
  useEffect(() => {
    const eventIdKey = kind === "artist" ? "artistId" : kind === "album" ? "albumId" : "tagId";
    const readyEvent = `${kind}-image-ready`;
    const errorEvent = `${kind}-image-error`;

    const unlistenReady = listen<Record<string, unknown>>(readyEvent, (event) => {
      const id = event.payload[eventIdKey] as number;
      const path = event.payload.path as string;
      const entityName = (event.payload.name ?? event.payload.title ?? `id=${id}`) as string;
      const source = event.payload.source as string | undefined;
      addLog?.(`${kind.charAt(0).toUpperCase() + kind.slice(1)} image downloaded for "${entityName}"${source ? ` from ${source}` : ""}`);
      setImages((prev) => ({ ...prev, [id]: path }));
    });

    const unlistenError = listen<Record<string, unknown>>(errorEvent, (event) => {
      const id = event.payload[eventIdKey] as number;
      const error = event.payload.error as string;
      const entityName = (event.payload.name ?? event.payload.title ?? `id=${id}`) as string;
      addLog?.(`${kind.charAt(0).toUpperCase() + kind.slice(1)} image failed for "${entityName}": ${error}`);
      failed.current = new Set(failed.current).add(id);
    });

    return () => {
      unlistenReady.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, [kind, addLog]);

  return { images, fetchOnDemand, setLocalImage, clearImage, clearAllFailures, setImages };
}
