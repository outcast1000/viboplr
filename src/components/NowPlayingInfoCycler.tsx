import { useEffect, useState } from "react";
import { nextCycleIndex, type NowPlayingInfoResolved } from "../hooks/useNowPlayingInfo";

interface NowPlayingInfoCyclerProps {
  items: NowPlayingInfoResolved[];
  className?: string;
  /** Separator between segments of one item (e.g. " · " or " — "). */
  sep?: string;
  /** Text-only: no clickable links, no rank badges. Used by the mini player. */
  plain?: boolean;
  /** Shown when `items` is empty so the line is never blank (e.g. artist name). */
  fallbackText?: string;
  onNavigateToArtistByName?: (name: string) => void;
  onNavigateToAlbumByName?: (name: string, artistName?: string) => void;
  intervalMs?: number;
}

/**
 * Renders the dynamic, auto-cycling Now Playing info line. The host resolves a
 * list of enabled items (`useNowPlayingInfo`); this component cycles through
 * them, animating each change with the shared `slide-text-enter` keyframe (the
 * same effect `SlideText` uses). One item → static, no timer.
 */
export function NowPlayingInfoCycler({
  items,
  className,
  sep = " · ",
  plain,
  fallbackText,
  onNavigateToArtistByName,
  onNavigateToAlbumByName,
  intervalMs = 5_000,
}: NowPlayingInfoCyclerProps) {
  const [index, setIndex] = useState(0);

  // Clamp the index when the item set changes (e.g. user toggles an item off).
  useEffect(() => {
    setIndex((i) => (items.length === 0 ? 0 : i % items.length));
  }, [items.length]);

  // Auto-cycle only when there's more than one item to show.
  useEffect(() => {
    if (items.length <= 1) return;
    const t = setInterval(() => setIndex((i) => nextCycleIndex(i, items.length)), intervalMs);
    return () => clearInterval(t);
  }, [items.length, intervalMs]);

  const active = items.length > 0 ? items[Math.min(index, items.length - 1)] : null;

  if (!active) {
    return fallbackText ? <span className={className}>{fallbackText}</span> : null;
  }

  // Re-key on index + content so a cycle change AND a track change both animate.
  const animKey = `${index}:${active.id}:${active.segments.map((s) => s.text).join("|")}`;

  return (
    <span className={className}>
      <span key={animKey} className="slide-text-enter">
        {active.segments.map((seg, i) => {
          const navable = !plain && !!seg.nav;
          return (
            <span key={i}>
              {i > 0 && <span className="now-sep">{sep}</span>}
              {navable ? (
                <span
                  className="now-link"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (seg.nav!.kind === "artist") onNavigateToArtistByName?.(seg.nav!.name);
                    else onNavigateToAlbumByName?.(seg.nav!.name, seg.nav!.artistName);
                  }}
                >
                  {seg.text}
                </span>
              ) : (
                <span>{seg.text}</span>
              )}
              {!plain && seg.badge != null && (
                <span className="now-rank-badge" title={`Rank #${seg.badge}`}>#{seg.badge}</span>
              )}
            </span>
          );
        })}
      </span>
    </span>
  );
}
