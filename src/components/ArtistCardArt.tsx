import type { Artist } from "../types";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import { EntityArtFallback } from "./EntityArtFallback";
import "./ArtistCardArt.css";

interface ArtistCardArtProps {
  artist: Artist;
  imagePath: string | null | undefined;
  className?: string;
}

export function ArtistCardArt({ artist, imagePath, className }: ArtistCardArtProps) {
  return (
    <div className={className ?? "artist-card-art"}>
      {imagePath ? (
        <img className="artist-card-art-img" src={resolveImageUrl(imagePath)} alt={artist.name} />
      ) : (
        <EntityArtFallback kind="artist" />
      )}
    </div>
  );
}
