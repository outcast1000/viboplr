import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Artist } from "../types";
import "./ArtistCardArt.css";

function getInitials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

interface ArtistCardArtProps {
  artist: Artist;
  imagePath: string | null | undefined;
  onVisible: (artist: Artist) => void;
  className?: string;
}

export function ArtistCardArt({ artist, imagePath, onVisible, className }: ArtistCardArtProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || imagePath !== undefined) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { onVisible(artist); observer.disconnect(); } },
      { threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [artist, imagePath, onVisible]);

  return (
    <div ref={ref} className={className ?? "artist-card-art"}>
      {imagePath ? (
        <img className="artist-card-art-img" src={convertFileSrc(imagePath)} alt={artist.name} />
      ) : (
        getInitials(artist.name)
      )}
    </div>
  );
}
