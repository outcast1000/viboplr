import { useEffect, useState } from "react";
import "./DetailHeroBackground.css";

interface Props {
  images: string[];   // 0-4 entries; component handles all fallbacks
  className?: string;
}

const MAX_LAYERS = 4;
const HOLD_MS = 7000;   // how long each image stays fully visible
// NOTE: the cross-fade duration lives in DetailHeroBackground.css
// (.detail-hero-bg-layer transition). Keep them in sync if you change it.

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Full-bleed background that slowly cross-fades between the supplied images.
// Each image fills the whole hero (no slicing) — `background-size: cover` crops
// it to the panel. With a single image it renders static; with none it's empty.
// The effect/look layer (DetailHeroEffect) sits on top and is unaffected.
export function DetailHeroBackground({ images, className }: Props) {
  const layers = images.slice(0, MAX_LAYERS);
  const [active, setActive] = useState(0);

  // Reset to the first image whenever the set of images changes, so navigating
  // to a different entity doesn't start mid-cycle on a stale index.
  const key = layers.join("|");
  useEffect(() => {
    setActive(0);
  }, [key]);

  // Auto-advance the active layer. Only cycles when there's more than one image
  // and the user hasn't asked to reduce motion.
  useEffect(() => {
    if (layers.length <= 1 || prefersReducedMotion()) return;
    const id = setInterval(() => {
      setActive(prev => (prev + 1) % layers.length);
    }, HOLD_MS);
    return () => clearInterval(id);
  }, [key, layers.length]);

  return (
    <div className={`detail-hero-bg ${className ?? ""}`} aria-hidden="true">
      {layers.map((src, i) => (
        <Layer key={src} src={src} active={i === active} />
      ))}
    </div>
  );
}

function Layer({ src, active }: { src: string; active: boolean }) {
  const [entered, setEntered] = useState(false);

  // Defer the first reveal to the next frame so the browser commits the hidden
  // (opacity:0) state before we flip to visible — without this the transition
  // can be collapsed and the fade-in skipped. Re-running on every mount (rather
  // than a one-shot ref) keeps this correct under React StrictMode's
  // mount/unmount/remount, where a ref guard would leave `entered` stuck false.
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      className={`detail-hero-bg-layer ${entered && active ? "active" : ""}`}
      style={{ backgroundImage: `url("${src.replace(/"/g, '\\"')}")` }}
    />
  );
}
