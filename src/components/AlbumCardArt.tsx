import type { Album } from "../types";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import "./AlbumCardArt.css";

interface AlbumCardArtProps {
  album: Album;
  imagePath: string | null | undefined;
}

export function AlbumCardArt({ album, imagePath }: AlbumCardArtProps) {
  return (
    <div className="album-card-art">
      {imagePath ? (
        <img className="album-card-art-img" src={resolveImageUrl(imagePath)} alt={album.title} />
      ) : (
        album.title[0]?.toUpperCase() ?? "?"
      )}
    </div>
  );
}
