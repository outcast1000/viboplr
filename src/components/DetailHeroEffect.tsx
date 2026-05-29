import { useEffect, useRef } from "react";
import tvNoise from "../assets/tv-noise.png";
import { hasOverlayLayers, type HeroLook } from "../heroLooks";
import "./DetailHeroEffect.css";

interface Props {
  /** The resolved look to render, or null to render nothing. */
  look: HeroLook | null;
}

/**
 * Whether the effect's animations should be paused. We only spend animation
 * cycles when the hero is both on-screen AND the page is visible.
 */
export function shouldPauseEffect(onScreen: boolean, pageVisible: boolean): boolean {
  return !(onScreen && pageVisible);
}

/**
 * Old-TV / VHS background effect for the detail hero. Pure presentational +
 * GPU-composited CSS animation where possible. Pauses (via the `tv-paused`
 * class) when the hero is scrolled out of view or the window is hidden, so it
 * never burns cycles in the background. Static fallback for
 * prefers-reduced-motion lives in the CSS. The B&W background modifier and the
 * motion are applied by DetailHero on the hero root, not here.
 */
export function DetailHeroEffect({ look }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = look !== null && hasOverlayLayers(look);

  useEffect(() => {
    if (!visible) return;
    const el = rootRef.current;
    if (!el) return;

    let onScreen = true;
    let pageVisible = !document.hidden;

    const apply = () => {
      el.classList.toggle("tv-paused", shouldPauseEffect(onScreen, pageVisible));
    };

    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              onScreen = entries[0]?.isIntersecting ?? true;
              apply();
            },
            { threshold: 0 },
          )
        : null;
    io?.observe(el);

    const onVisibility = () => {
      pageVisible = !document.hidden;
      apply();
    };
    document.addEventListener("visibilitychange", onVisibility);
    apply();

    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [visible, look?.id]);

  if (!visible || !look) return null;

  const l = look.layers;
  return (
    <div
      ref={rootRef}
      className={`detail-hero-effect look-${look.id}`}
      aria-hidden="true"
      style={{ ["--tv-noise" as string]: `url(${tvNoise})` }}
    >
      {l.bleed && <div className="tv-bleed" />}
      {l.bleed2 && <div className="tv-bleed-2" />}
      {l.scan && <div className="tv-scan" />}
      {l.flicker && <div className="tv-flicker" />}
      {l.track && <div className="tv-track" />}
      {l.noise && <div className="tv-noise" />}
      {l.auroraA && <div className="tv-auroraA" />}
      {l.auroraB && <div className="tv-auroraB" />}
      {l.leakWarm && <div className="tv-leakWarm" />}
      {l.leakCorner && <div className="tv-leakCorner" />}
      {l.bloom && <div className="tv-bloom" />}
      {l.fringe && <div className="tv-fringe" />}
      {l.grid && <div className="tv-grid" />}
      {l.gridGlow && <div className="tv-gridGlow" />}
      {l.vignette && <div className="tv-vignette" />}
    </div>
  );
}
