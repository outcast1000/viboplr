import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Tag } from "../types";

interface TagCardArtProps {
  tag: Tag;
  imagePath: string | null | undefined;
  onVisible: (tag: Tag) => void;
  className?: string;
}

export function TagCardArt({ tag, imagePath, onVisible, className }: TagCardArtProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || imagePath !== undefined) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { onVisible(tag); observer.disconnect(); } },
      { threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [tag, imagePath, onVisible]);

  return (
    <div ref={ref} className={className ?? "tag-card-art"}>
      {imagePath ? (
        <img className="tag-card-art-img" src={convertFileSrc(imagePath)} alt={tag.name} />
      ) : (
        tag.name[0]?.toUpperCase() ?? "#"
      )}
    </div>
  );
}
