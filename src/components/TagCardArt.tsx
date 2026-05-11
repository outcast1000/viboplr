import { convertFileSrc } from "@tauri-apps/api/core";
import type { Tag } from "../types";
import "./TagCardArt.css";

interface TagCardArtProps {
  tag: Tag;
  imagePath: string | null | undefined;
  className?: string;
}

export function TagCardArt({ tag, imagePath, className }: TagCardArtProps) {
  return (
    <div className={className ?? "tag-card-art"}>
      {imagePath ? (
        <img className="tag-card-art-img" src={convertFileSrc(imagePath)} alt={tag.name} />
      ) : (
        tag.name[0]?.toUpperCase() ?? "#"
      )}
    </div>
  );
}
