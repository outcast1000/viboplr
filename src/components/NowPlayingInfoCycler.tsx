import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type MouseEventHandler, type ReactNode, type SetStateAction } from "react";
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
// Floor on one-direction glide time. Speed is constant, so a small shift would
// otherwise glide in a few hundred ms — a fast, twitchy wiggle. Flooring keeps a
// short marquee as calm as a long one (long lines already exceed this), which is
// what makes it safe to scroll on ANY overflow instead of ever ellipsis-truncating.
const MARQUEE_MIN_DURATION_MS = 1200;
const MARQUEE_CYCLE_BUFFER_MS = 400;    // grace so the tail is read before the cycler advances
// A line must hold still this long before it begins scrolling. Frequently-changing
// content (synced lyrics ticking line-by-line) keeps resetting this timer, so it
// never scrolls — it stays put and ellipsis-truncates, calm. Only genuinely stable
// content (a long Artist · Album) survives the settle and glides. This is what keeps
// the marquee from restart-storming on lyrics.
const MARQUEE_SETTLE_MS = 1200;

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
 * geometry + timing. Returns null only when the content fits or the viewport is
 * too small to measure — any real overflow scrolls (a clipped line never shows
 * an ellipsis). Extracted for unit testing.
 */
export function computeMarquee(
  scrollWidth: number,
  clientWidth: number,
  speedPxPerSec: number = MARQUEE_SPEED_PX_PER_SEC,
): MarqueePlan | null {
  if (clientWidth < MARQUEE_MIN_VIEWPORT) return null;
  const overflow = scrollWidth - clientWidth;
  // Scroll on ANY real overflow so a clipped line never shows an ellipsis. A 1px
  // subpixel-rounding overflow is harmless: the duration floor drifts it ~1px over
  // MARQUEE_MIN_DURATION_MS, which is imperceptible.
  if (overflow <= 0) return null;
  const travelMs = (overflow / speedPxPerSec) * 1000;
  const durMs = Math.max(MARQUEE_MIN_DURATION_MS, Math.round(travelMs / MARQUEE_GLIDE_FRACTION));
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
  // The marquee only engages once the current plan has held still for the settle
  // window. Any plan change (a new/wider/narrower line) resets it, so content that
  // keeps changing — synced lyrics — never actually scrolls; it truncates instead.
  const [settled, setSettled] = useState(false);
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

  // Hold still before scrolling: reset on every plan change and re-arm the timer.
  // A line that keeps changing (lyrics) never reaches `settled`, so it stays put.
  useEffect(() => {
    if (!plan) { setSettled(false); return; }
    setSettled(false);
    const t = setTimeout(() => setSettled(true), MARQUEE_SETTLE_MS);
    return () => clearTimeout(t);
  }, [plan]);

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

  // Only scroll once the plan has settled; until then (and for ever-changing
  // content) the line sits at origin and ellipsis-truncates.
  const scrolling = !!plan && settled;
  const style = scrolling
    ? ({ "--npi-shift": `${-plan.shift}px`, "--npi-dur": `${plan.durMs}ms` } as CSSProperties)
    : undefined;
  return (
    <span ref={setViewport} className={className} onClick={onClick} title={title}>
      <span key={restartKey} ref={setTrack} className={scrolling ? "npi-track npi-marquee" : "npi-track"} style={style}>
        {children}
      </span>
    </span>
  );
}

/** The cycle phase (which item is up + whether the opening preview pass is
 *  still running), lifted to the parent. The mini player renders a different
 *  cycler instance per row (compact ultra vs. expanded/normal), so if this
 *  state lived inside the component, hover-expanding would remount the cycler
 *  and replay the preview pass on every mouse-over. `key` tags the track the
 *  phase belongs to: only an actual track change (key mismatch) restarts the
 *  cycle — a remount with the same key resumes where the cycle was. */
export interface NowPlayingCycleState {
  key: string | undefined;
  index: number;
  previewing: boolean;
}

export function initialCycleState(): NowPlayingCycleState {
  return { key: undefined, index: 0, previewing: true };
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
  /** Lifted cycle phase, owned by the parent — see NowPlayingCycleState. */
  cycleState: NowPlayingCycleState;
  onCycleState: Dispatch<SetStateAction<NowPlayingCycleState>>;
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
 * The phase lives in the parent (`cycleState`/`onCycleState`) and resets only
 * when `cycleResetKey` actually changes (i.e. a new track) — not when this
 * instance remounts (the mini player swaps rows on hover-expand).
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
  cycleState,
  onCycleState,
  marquee: marqueeEnabled,
}: NowPlayingInfoCyclerProps) {
  // `index` is the position in the active list; `previewing` is true during the
  // opening preview pass and flips to false once it completes. Both live in the
  // parent (see NowPlayingCycleState) so they survive this instance remounting.
  const { index, previewing } = cycleState;

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

  // New track → restart the cycle and re-run the preview pass. Compared against
  // the state's own key so only a real track change resets — a remount alone
  // (the mini player swaps cycler instances when hover-expanding the compact
  // row) resumes the phase instead of replaying the preview.
  useEffect(() => {
    onCycleState((s) => (s.key === cycleResetKey ? s : { key: cycleResetKey, index: 0, previewing: true }));
  }, [cycleResetKey, onCycleState]);

  // Clamp the index when the active list shrinks (e.g. user toggles an item off).
  useEffect(() => {
    onCycleState((s) => {
      const len = s.previewing ? items.length : steady.length;
      const next = len === 0 ? 0 : s.index % len;
      return next === s.index ? s : { ...s, index: next };
    });
  }, [previewing, items.length, steady.length, onCycleState]);

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
        onCycleState((s) =>
          next >= len
            ? { ...s, index: 0, previewing: false } // preview complete → enter steady rotation
            : { ...s, index: next },
        );
      }, Math.max(intervalMs, marqueeMsRef.current));
      return () => clearTimeout(t);
    }
    const len = steadyRef.current.length;
    if (len <= 1) return; // 0 or 1 steady items → nothing to cycle
    const clamped = Math.min(index, len - 1);
    const mult = steadyRef.current[clamped]?.top ?? 1;
    const t = setTimeout(() => {
      onCycleState((s) => ({ ...s, index: nextCycleIndex(Math.min(s.index, len - 1), len) }));
    }, Math.max(intervalMs * mult, marqueeMsRef.current));
    return () => clearTimeout(t);
  }, [previewing, index, items.length, steady.length, intervalMs, onCycleState]);

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
  // Marquee-track identity keys on the item only (NOT its text). A synced-lyrics
  // line change swaps the inner text (which re-runs the crossfade) but must NOT
  // remount the scrolling track — otherwise the glide jumps back to the left on
  // every lyric line. Only cycling to a different item (or a new track) restarts.
  const itemKey = `${index}:${active.id}`;
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

  // Keyed on the full content so each item/line swap re-runs the crossfade — even
  // when the enclosing marquee track is NOT remounting (see `itemKey`).
  const slide = (
    <span key={animKey} className={styleClass ? `slide-text-enter ${styleClass}` : "slide-text-enter"}>
      {content}
    </span>
  );

  // Non-marquee callers (full bar, or the compact row where an outer MarqueeText
  // scrolls the whole line) keep the original two-span structure.
  if (!marqueeEnabled) {
    marqueeMsRef.current = 0;
    return <span className={className}>{slide}</span>;
  }

  return (
    <MarqueeText
      className={className}
      enabled
      restartKey={itemKey}
      onPlan={(p) => { marqueeMsRef.current = p?.cycleMs ?? 0; }}
    >
      {slide}
    </MarqueeText>
  );
}
