import { useEffect, useRef } from "react";
import { isReducedMotion, subscribeReducedMotion } from "../utils/reducedMotion";
import { isWindowHidden, subscribeWindowHidden } from "../utils/windowVisibility";

/**
 * Turntable rotation for the playback icons (`SpinningDisc`, `FilmReel`): spins
 * while `playing`, and on pause it *slows to a stop* — and spins back up on play
 * — instead of freezing on the spot.
 *
 * Everything is a Web Animations transform, so it runs on the compositor and
 * the ramps are one-shot (rule: frontend.md → App.css "New motion must be
 * cheap"). A ramp is a single eased rotation whose curve is chosen so the speed
 * at the hand-off matches the steady spin — no jolt:
 *  - spin-down: ease-out cubic starts at 3× its average speed, so travelling
 *    `rampDegrees(period)` over RAMP_MS starts at exactly one turn per `period`;
 *  - spin-up: ease-in cubic ends at 3× its average speed, same distance.
 * The paused angle is kept (the old CSS version snapped back to 0°).
 *
 * Three details are load-bearing:
 *  - **Reduced motion is checked here.** The global CSS guard in base.css does
 *    not reach `element.animate()`, so this reads `isReducedMotion()` and
 *    subscribes to live toggles; reduced, the icon holds still at its angle.
 *  - **A pause waits BLIP_MS before slowing.** `playing` is driven by media and
 *    engine events, and a false→true flicker at a track boundary would otherwise
 *    stutter every track change — during the steady spin *and* mid spin-up.
 *  - **It holds still while the window is hidden.** The CSS pause on
 *    `data-window-hidden` (base.css) can't reach `element.animate()` either,
 *    so the steady spin pauses itself and resumes at the same angle.
 *  - **Nothing is allocated until the first play** — no animation and no
 *    reduce-motion subscription — a track list can show many idle discs at once.
 */
export const SPIN_RAMP_MS = 600;
const BLIP_MS = 150;
const EASE_OUT_CUBIC = "cubic-bezier(0.33, 1, 0.68, 1)";
const EASE_IN_CUBIC = "cubic-bezier(0.32, 0, 0.67, 0)";

/** Degrees a ramp travels so its fast end matches one turn per `periodMs`. */
export function rampDegrees(periodMs: number): number {
  return (360 * SPIN_RAMP_MS) / (3 * periodMs);
}

/** The rotation an element is currently drawn at, animations included. */
function currentAngle(el: Element): number {
  const t = getComputedStyle(el).transform;
  const m = t && t !== "none" ? /matrix\(([^)]+)\)/.exec(t) : null;
  if (!m) return 0;
  const [a, b] = m[1].split(",").map(Number);
  return (Math.atan2(b, a) * 180) / Math.PI;
}

const rot = (deg: number) => ({ transform: `rotate(${deg}deg)` });

export function useSpin(ref: React.RefObject<Element | null>, playing: boolean, periodMs: number) {
  const anim = useRef<Animation | null>(null);
  const mode = useRef<"idle" | "up" | "loop" | "down">("idle");
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRun = useRef(true);
  const playingRef = useRef(playing);
  const periodRef = useRef(periodMs);
  const unsubscribe = useRef<(() => void) | null>(null);
  const unsubscribeHidden = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = ref.current;
    const wasFirst = firstRun.current;
    firstRun.current = false;
    playingRef.current = playing;
    periodRef.current = periodMs;
    if (!el || typeof el.animate !== "function") return;

    const replace = (next: Animation | null, nextMode: typeof mode.current) => {
      anim.current?.cancel();
      anim.current = next;
      mode.current = nextMode;
    };
    /** Hold still at `deg` (cancelling alone would snap the icon to 0°). */
    const holdAt = (deg: number) =>
      replace(el.animate([rot(deg), rot(deg)], { duration: 1, fill: "forwards" }), "idle");
    const loopFrom = (deg: number) => {
      replace(el.animate([rot(deg), rot(deg + 360)], { duration: periodRef.current, iterations: Infinity }), "loop");
      if (isWindowHidden()) anim.current?.pause();
    };

    if (playing) {
      if (stopTimer.current) {
        // A blip: the pause never got as far as slowing down.
        clearTimeout(stopTimer.current);
        stopTimer.current = null;
      }
      if (mode.current === "loop" || mode.current === "up") return; // already spinning (or getting there)
      // First animation of this instance: only now subscribe to live toggles.
      unsubscribe.current ??= subscribeReducedMotion(() => {
        if (isReducedMotion()) {
          if (stopTimer.current) { clearTimeout(stopTimer.current); stopTimer.current = null; }
          holdAt(currentAngle(el));
        } else if (playingRef.current && mode.current !== "loop" && mode.current !== "up") {
          loopFrom(currentAngle(el));
        }
      });
      unsubscribeHidden.current ??= subscribeWindowHidden((hidden) => {
        if (mode.current !== "loop") return; // ramps are one-shot and short
        if (hidden) anim.current?.pause();
        else anim.current?.play();
      });
      if (isReducedMotion()) return;
      const from = currentAngle(el);
      if (wasFirst) { loopFrom(from); return; } // mounted mid-play: just spin
      const to = from + rampDegrees(periodMs);
      const up = el.animate([rot(from), rot(to)], { duration: SPIN_RAMP_MS, easing: EASE_IN_CUBIC, fill: "forwards" });
      replace(up, "up");
      up.onfinish = () => { if (anim.current === up) loopFrom(to); };
      return;
    }

    if (mode.current === "idle" || mode.current === "down" || stopTimer.current) return;
    stopTimer.current = setTimeout(() => {
      stopTimer.current = null;
      const from = currentAngle(el);
      replace(
        el.animate([rot(from), rot(from + rampDegrees(periodMs))], { duration: SPIN_RAMP_MS, easing: EASE_OUT_CUBIC, fill: "forwards" }),
        "down",
      );
    }, BLIP_MS);
  }, [playing, periodMs, ref]);

  useEffect(() => () => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    anim.current?.cancel();
    anim.current = null;
    unsubscribe.current?.();
    unsubscribe.current = null;
    unsubscribeHidden.current?.();
    unsubscribeHidden.current = null;
    // Back to a fresh mount: StrictMode (dev) unmounts and remounts with these
    // refs intact, and a stale "loop" mode made the re-run effect return early,
    // leaving a disc mounted mid-play frozen.
    mode.current = "idle";
    firstRun.current = true;
  }, []);
}
