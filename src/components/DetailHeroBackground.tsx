import { useEffect, useState } from "react";
import "./DetailHeroBackground.css";

interface Props {
  images: string[];   // 0-4 entries; component handles all fallbacks
  className?: string;
}

const MAX_LAYERS = 4;

// Slice geometry for side-by-side layout with soft overlap. Each layer occupies
// `width` of the hero, anchored at `left`. Adjacent layers overlap by ~20%.
function layerSlice(index: number, count: number): { left: string; width: string } {
  const slice = 100 / count;          // base slice (e.g., 50% for 2 layers)
  const overlap = count > 1 ? 10 : 0; // half of the 20% overlap on each side
  const left = Math.max(0, index * slice - overlap);
  const right = Math.min(100, (index + 1) * slice + overlap);
  return { left: `${left}%`, width: `${right - left}%` };
}

export function DetailHeroBackground({ images, className }: Props) {
  const visible = images.slice(0, MAX_LAYERS);
  return (
    <div className={`detail-hero-bg ${className ?? ""}`} aria-hidden="true">
      {visible.map((src, i) => (
        <Layer
          key={src}
          src={src}
          slice={layerSlice(i, visible.length)}
          edge={visible.length > 1 ? (i === 0 ? "left" : i === visible.length - 1 ? "right" : "middle") : "full"}
        />
      ))}
    </div>
  );
}

function Layer({
  src,
  slice,
  edge,
}: {
  src: string;
  slice: { left: string; width: string };
  edge: "full" | "left" | "right" | "middle";
}) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    // Defer to the next frame so the initial opacity:0 is committed to the DOM
    // before we transition to opacity:1 — without this the browser may collapse
    // the change and skip the transition.
    const id = requestAnimationFrame(() => setLoaded(true));
    return () => cancelAnimationFrame(id);
  }, [src]);

  return (
    <div
      className={`detail-hero-bg-layer detail-hero-bg-edge-${edge} ${loaded ? "loaded" : ""}`}
      style={{
        backgroundImage: `url("${src.replace(/"/g, '\\"')}")`,
        left: slice.left,
        width: slice.width,
      }}
    />
  );
}
