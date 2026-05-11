import { convertFileSrc } from "@tauri-apps/api/core";
import type { Album } from "../types";
import "./AlbumCardArt.css";

interface AlbumCardArtProps {
  album: Album;
  imagePath: string | null | undefined;
}

export function AlbumCardArt({ album, imagePath }: AlbumCardArtProps) {
  return (
    <div className="album-card-art">
      {imagePath ? (
        <img className="album-card-art-img" src={convertFileSrc(imagePath)} alt={album.title} />
      ) : (
        album.title[0]?.toUpperCase() ?? "?"
      )}
    </div>
  );
}
