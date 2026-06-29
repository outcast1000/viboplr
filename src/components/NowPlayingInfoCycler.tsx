import { useEffect, useMemo, useRef, useState } from "react";
import { nextCycleIndex, nowPlayingSteadyOrder, nowPlayingStyleClass, type NowPlayingInfoResolved } from "../hooks/useNowPlayingInfo";

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
  /** Changes whenever the current track changes (e.g. its key). Restarts the
   *  cycle and re-runs the preview pass. */
  cycleResetKey?: string;
}

/**
 * Renders the dynamic, auto-cycling Now Playing info line. The host resolves a
 * list of enabled items (`useNowPlayingInfo`); this component cycles through
 * them, animating each change with the shared `slide-text-enter` keyframe (the
 * same effect `SlideText` uses).
 *
 * Two phases per track:
 *  1. Preview pass — every enabled item is shown once for the base interval (a
 *     quick overview), regardless of its time-of-persistence (`top`).
 *  2. Steady rotation — only items with `top > 0` remain in the loop, ordered
 *     by ToP descending (largest first), each dwelling for `intervalMs × top`.
 *     Items with `top === 0` ("preview only") are dropped after the preview pass.
 *
 * The phase resets on every `cycleResetKey` change (i.e. every new track).
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
  cycleResetKey,
}: NowPlayingInfoCyclerProps) {
  const [index, setIndex] = useState(0);
  // true during the opening preview pass; flips to false once it completes.
  const [previewing, setPreviewing] = useState(true);

  // The steady-rotation list excludes "preview only" (top === 0) items and is
  // ordered by ToP descending, so the longest-dwelling items lead the cycle.
  const steady = useMemo(() => nowPlayingSteadyOrder(items), [items]);

  // Read the latest lists inside the timer without resetting it — the `items`
  // array identity changes every position tick when synced lyrics are enabled,
  // and we must not restart a long dwell on each of those updates.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const steadyRef = useRef(steady);
  steadyRef.current = steady;

  // New track → restart the cycle and re-run the preview pass.
  useEffect(() => {
    setIndex(0);
    setPreviewing(true);
  }, [cycleResetKey]);

  // Clamp the index when the active list shrinks (e.g. user toggles an item off).
  useEffect(() => {
    const len = previewing ? items.length : steady.length;
    setIndex((i) => (len === 0 ? 0 : i % len));
  }, [previewing, items.length, steady.length]);

  // Self-rescheduling timer. During the preview pass every item dwells for the
  // base interval; afterwards each steady item dwells for `intervalMs × top`.
  useEffect(() => {
    if (previewing) {
      const len = items.length;
      if (len <= 1) return; // nothing to preview-cycle; the single item stays put
      const clamped = Math.min(index, len - 1);
      const t = setTimeout(() => {
        const next = clamped + 1;
        if (next >= len) {
          setPreviewing(false); // preview complete → enter steady rotation
          setIndex(0);
        } else {
          setIndex(next);
        }
      }, intervalMs);
      return () => clearTimeout(t);
    }
    const len = steadyRef.current.length;
    if (len <= 1) return; // 0 or 1 steady items → nothing to cycle
    const clamped = Math.min(index, len - 1);
    const mult = steadyRef.current[clamped]?.top ?? 1;
    const t = setTimeout(() => {
      setIndex((i) => nextCycleIndex(Math.min(i, len - 1), len));
    }, intervalMs * mult);
    return () => clearTimeout(t);
  }, [previewing, index, items.length, steady.length, intervalMs]);

  // The list the current index points into depends on the phase. After the
  // preview pass, if every item was "preview only" (steady is empty), fall back
  // to the full list so the line freezes on an item rather than going blank.
  const activeList = previewing ? items : steady.length > 0 ? steady : items;
  const active = activeList.length > 0 ? activeList[Math.min(index, activeList.length - 1)] : null;

  if (!active) {
    return fallbackText ? <span className={className}>{fallbackText}</span> : null;
  }

  // Re-key on index + content so a cycle change AND a track change both animate.
  const animKey = `${index}:${active.id}:${active.segments.map((s) => s.text).join("|")}`;
  const styleClass = nowPlayingStyleClass(active.style);

  return (
    <span className={className}>
      <span key={animKey} className={styleClass ? `slide-text-enter ${styleClass}` : "slide-text-enter"}>
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
