import { convertFileSrc } from "@tauri-apps/api/core";
import type { Artist } from "../types";
import "./ArtistCardArt.css";

function getInitials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

interface ArtistCardArtProps {
  artist: Artist;
  imagePath: string | null | undefined;
  className?: string;
}

export function ArtistCardArt({ artist, imagePath, className }: ArtistCardArtProps) {
  return (
    <div className={className ?? "artist-card-art"}>
      {imagePath ? (
        <img className="artist-card-art-img" src={convertFileSrc(imagePath)} alt={artist.name} />
      ) : (
        getInitials(artist.name)
      )}
    </div>
  );
}
