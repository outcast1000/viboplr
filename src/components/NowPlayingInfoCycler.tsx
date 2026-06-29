import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEventHandler, type ReactNode } from "react";
import { nextCycleIndex, nowPlayingSteadyOrder, nowPlayingStyleClass, type NowPlayingInfoResolved } from "../hooks/useNowPlayingInfo";
import { isReducedMotion, subscribeReducedMotion } from "../utils/reducedMotion";

// === Marquee tuning ===
// A line wider than its viewport (a long lyric line, especially at the narrow
// mini-player widths) is otherwise ellipsis-truncated and unreadable. We gently
// ping-pong the overflowing line so the whole thing can be read; lines that fit
// never animate.
const MARQUEE_SPEED_PX_PER_SEC = 45;    // readable glide speed
const MARQUEE_GLIDE_FRACTION = 0.78;    // per direction: 78% glide / 22% rest at the edge
const MARQUEE_MIN_VIEWPORT = 20;        // px; below this the viewport isn't meaningfully measurable
const MARQUEE_OVERFLOW_THRESHOLD = 4;   // px of overflow before it's worth scrolling
const MARQUEE_CYCLE_BUFFER_MS = 400;    // grace so the tail is read before the cycler advances

export interface MarqueePlan {
  /** px to translate the track left so its tail becomes visible. */
  shift: number;
  /** duration of one direction (the built-in edge rest + the glide); feeds `--npi-dur`. */
  durMs: number;
  /** minimum time the cycler should keep this item up to complete a forward glide. */
  cycleMs: number;
}

/**
 * Pure: decide whether content overflows its line and, if so, the marquee
 * geometry + timing. Returns null when it fits, the overflow is negligible, or
 * the viewport is too small to measure. Extracted for unit testing.
 */
export function computeMarquee(
  scrollWidth: number,
  clientWidth: number,
  speedPxPerSec: number = MARQUEE_SPEED_PX_PER_SEC,
): MarqueePlan | null {
  if (clientWidth < MARQUEE_MIN_VIEWPORT) return null;
  const overflow = scrollWidth - clientWidth;
  if (overflow <= MARQUEE_OVERFLOW_THRESHOLD) return null;
  const travelMs = (overflow / speedPxPerSec) * 1000;
  const durMs = Math.round(travelMs / MARQUEE_GLIDE_FRACTION);
  return { shift: overflow, durMs, cycleMs: durMs + MARQUEE_CYCLE_BUFFER_MS };
}

function samePlan(a: MarqueePlan | null, b: MarqueePlan | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.shift === b.shift && a.durMs === b.durMs;
}

interface MarqueeTextProps {
  className?: string;
  /** When false, renders children statically (single-line ellipsis from `className`). */
  enabled?: boolean;
  /** Restarts the glide from the left when it changes (e.g. a new item / track).
   *  Width-only changes (the same line getting wider) are picked up live by a
   *  ResizeObserver without a restart. */
  restartKey?: string;
  /** Notified with the current plan (or null). The cycler uses it to hold an
   *  item long enough to finish a glide before advancing. */
  onPlan?: (plan: MarqueePlan | null) => void;
  /** Forwarded to the viewport span so the marquee can also be the clickable
   *  element (e.g. the now-playing-bar title navigates to the track). */
  onClick?: MouseEventHandler<HTMLSpanElement>;
  /** Native tooltip on the viewport (e.g. the full title on hover). */
  title?: string;
  children: ReactNode;
}

/**
 * Scrolls its children horizontally when they're wider than the line, so the
 * whole line can be read. Measures the rendered track against its viewport and,
 * on overflow, ping-pongs it (CSS `npi-marquee`, `infinite alternate`); when it
 * fits, the line stays put and ellipsis-truncates. Reduced-motion keeps the
 * static line (no `npi-marquee`, and the global guard neutralises it as a
 * backstop). Used both for the mini player's two-line info line and to scroll
 * the whole single line of the compact (ultra) row.
 */
export function MarqueeText({ className, enabled, restartKey, onPlan, onClick, title, children }: MarqueeTextProps) {
  const [plan, setPlan] = useState<MarqueePlan | null>(null);
  const reducedRef = useRef(false);
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const trackRef = useRef<HTMLSpanElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const onPlanRef = useRef(onPlan);
  onPlanRef.current = onPlan;

  const measure = useCallback(() => {
    const vp = viewportRef.current;
    const tr = trackRef.current;
    if (!enabled || !vp || !tr || reducedRef.current) {
      onPlanRef.current?.(null);
      setPlan((prev) => (prev === null ? prev : null));
      return;
    }
    const p = computeMarquee(tr.scrollWidth, vp.clientWidth);
    onPlanRef.current?.(p);
    setPlan((prev) => (samePlan(prev, p) ? prev : p));
  }, [enabled]);

  // Track reduce-motion (OS preference OR in-app toggle); never marquee when set.
  useEffect(() => {
    const update = () => { reducedRef.current = isReducedMotion(); measure(); };
    update();
    return subscribeReducedMotion(update);
  }, [measure]);

  // One observer watches both the viewport (line width: mini size small/medium/
  // large) and the track (content width: the info item cycling underneath).
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    roRef.current = ro;
    if (viewportRef.current) ro.observe(viewportRef.current);
    if (trackRef.current) ro.observe(trackRef.current);
    return () => { ro.disconnect(); roRef.current = null; };
  }, [measure]);

  // Measure before paint when the content/track restarts.
  useLayoutEffect(() => { measure(); }, [restartKey, measure]);

  const setViewport = useCallback((el: HTMLSpanElement | null) => {
    if (roRef.current && viewportRef.current) roRef.current.unobserve(viewportRef.current);
    viewportRef.current = el;
    if (roRef.current && el) roRef.current.observe(el);
  }, []);

  // Callback ref so the observer survives the track remounting on `restartKey`.
  const setTrack = useCallback((el: HTMLSpanElement | null) => {
    if (roRef.current && trackRef.current) roRef.current.unobserve(trackRef.current);
    trackRef.current = el;
    if (roRef.current && el) roRef.current.observe(el);
    if (el) measure();
  }, [measure]);

  if (!enabled) {
    return <span className={className} onClick={onClick} title={title}>{children}</span>;
  }

  const style = plan
    ? ({ "--npi-shift": `${-plan.shift}px`, "--npi-dur": `${plan.durMs}ms` } as CSSProperties)
    : undefined;
  return (
    <span ref={setViewport} className={className} onClick={onClick} title={title}>
      <span key={restartKey} ref={setTrack} className={plan ? "npi-track npi-marquee" : "npi-track"} style={style}>
        {children}
      </span>
    </span>
  );
}

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
  /** When true, the cycler owns the marquee for its own line (the two-line mini
   *  layout). When false, the line is rendered plain — either there's no overflow
   *  surface (full bar) or an enclosing `MarqueeText` scrolls the whole line (the
   *  compact/ultra row). */
  marquee?: boolean;
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
 *
 * When `marquee` is on, an item that doesn't fit its line scrolls (a gentle
 * ping-pong) so the whole item is readable, and the dwell for that item is
 * stretched to `max(dwell, scroll-cycle)` so it never advances mid-glide.
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
  marquee: marqueeEnabled,
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

  // Mirror of the active item's marquee `cycleMs` (set via MarqueeText's onPlan).
  // Read by the dwell timer WITHOUT being a dependency, so a synced-lyrics line
  // change (which re-measures) never resets the item's long dwell.
  const marqueeMsRef = useRef(0);

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
  // When the current item is marqueeing, the dwell is stretched (via the ref) so
  // the forward glide completes before we advance.
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
      }, Math.max(intervalMs, marqueeMsRef.current));
      return () => clearTimeout(t);
    }
    const len = steadyRef.current.length;
    if (len <= 1) return; // 0 or 1 steady items → nothing to cycle
    const clamped = Math.min(index, len - 1);
    const mult = steadyRef.current[clamped]?.top ?? 1;
    const t = setTimeout(() => {
      setIndex((i) => nextCycleIndex(Math.min(i, len - 1), len));
    }, Math.max(intervalMs * mult, marqueeMsRef.current));
    return () => clearTimeout(t);
  }, [previewing, index, items.length, steady.length, intervalMs]);

  // The list the current index points into depends on the phase. After the
  // preview pass, if every item was "preview only" (steady is empty), fall back
  // to the full list so the line freezes on an item rather than going blank.
  const activeList = previewing ? items : steady.length > 0 ? steady : items;
  const active = activeList.length > 0 ? activeList[Math.min(index, activeList.length - 1)] : null;

  if (!active) {
    marqueeMsRef.current = 0;
    return fallbackText ? <span className={className}>{fallbackText}</span> : null;
  }

  // Re-key on index + content so a cycle change AND a track change both animate.
  const animKey = `${index}:${active.id}:${active.segments.map((s) => s.text).join("|")}`;
  const styleClass = nowPlayingStyleClass(active.style);
  const content = active.segments.map((seg, i) => {
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
  });

  const slide = <span className={styleClass ? `slide-text-enter ${styleClass}` : "slide-text-enter"}>{content}</span>;

  // Non-marquee callers (full bar, or the compact row where an outer MarqueeText
  // scrolls the whole line) keep the original two-span structure.
  if (!marqueeEnabled) {
    marqueeMsRef.current = 0;
    return (
      <span className={className}>
        <span key={animKey}>{slide}</span>
      </span>
    );
  }

  return (
    <MarqueeText
      className={className}
      enabled
      restartKey={animKey}
      onPlan={(p) => { marqueeMsRef.current = p?.cycleMs ?? 0; }}
    >
      {slide}
    </MarqueeText>
  );
}
