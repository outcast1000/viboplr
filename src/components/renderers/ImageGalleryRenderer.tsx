import type { RendererProps } from "./index";
import type { ImageGalleryData } from "../../types/informationTypes";
import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

export function ImageGalleryRenderer({ data }: RendererProps) {
  const d = data as ImageGalleryData;
  const [activeIndex, setActiveIndex] = useState(0);
  if (!d?.images?.length) return null;

  const image = d.images[activeIndex];
  const isGallery = d.images.length > 1;

  return (
    <div className="renderer-image-gallery">
      <div className="gallery-main">
        <img src={image.url} alt={image.caption ?? ""} className="gallery-image" />
        {isGallery && (
          <>
            <button className="gallery-nav gallery-prev" onClick={() => setActiveIndex((activeIndex - 1 + d.images.length) % d.images.length)} disabled={d.images.length <= 1}>
              ‹
            </button>
            <button className="gallery-nav gallery-next" onClick={() => setActiveIndex((activeIndex + 1) % d.images.length)} disabled={d.images.length <= 1}>
              ›
            </button>
          </>
        )}
      </div>
      {image.caption && <p className="gallery-caption">{image.caption}</p>}
      {image.source && (image.pageUrl
        ? (
          <a
            href="#"
            className="gallery-source"
            title={image.pageUrl}
            onClick={(e) => {
              e.preventDefault();
              openUrl(image.pageUrl!).catch((err) => console.error("Failed to open image page:", err));
            }}
          >
            {image.source}
          </a>
        )
        : <span className="gallery-source">{image.source}</span>)}
      {isGallery && (
        <div className="gallery-dots">
          {d.images.map((_, i) => (
            <button key={i} className={`gallery-dot${i === activeIndex ? " active" : ""}`} onClick={() => setActiveIndex(i)} />
          ))}
        </div>
      )}
    </div>
  );
}
