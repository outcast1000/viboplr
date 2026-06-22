import type { Tag } from "../types";
import { resolveImageUrl } from "../utils/resolveImageUrl";
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
        <img className="tag-card-art-img" src={resolveImageUrl(imagePath)} alt={tag.name} />
      ) : (
        tag.name[0]?.toUpperCase() ?? "#"
      )}
    </div>
  );
}
