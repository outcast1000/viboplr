import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Album } from "../types";

interface AlbumCardArtProps {
  album: Album;
  imagePath: string | null | undefined;
  onVisible: (album: Album) => void;
}

export function AlbumCardArt({ album, imagePath, onVisible }: AlbumCardArtProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || imagePath !== undefined) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { onVisible(album); observer.disconnect(); } },
      { threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [album, imagePath, onVisible]);

  return (
    <div ref={ref} className="album-card-art">
      {imagePath ? (
        <img className="album-card-art-img" src={convertFileSrc(imagePath)} alt={album.title} />
      ) : (
        album.title[0]?.toUpperCase() ?? "?"
      )}
    </div>
  );
}
