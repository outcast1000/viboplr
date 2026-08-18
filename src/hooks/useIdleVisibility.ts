import { useCallback, useEffect, useRef, useState } from "react";

import { useAssignRef } from "./useLatestRef";
/** Matches the fullscreen bar and the video theater overlay — every auto-hiding
 *  surface in the app fades on the same beat. */
const DEFAULT_IDLE_MS = 3000;

export interface IdleVisibilityOptions {
  /** Arm the timer at all. False keeps the surface permanently visible — the
   *  fullscreen bar uses this to do nothing while it isn't fullscreen. */
  enabled?: boolean;
  /** Hold visible regardless of idle time, typically `!playing`: a paused
   *  surface is one the user is looking at, not leaning back from. */
  hold?: boolean;
  /** Element whose `mousemove` counts as activity. Held in a ref and re-read on
   *  each arm, so callers can pass an inline closure without re-registering the
   *  listener every render, and a parent that mounts late still gets wired. */
  getTarget: () => HTMLElement | null;
  timeoutMs?: number;
}

export interface IdleVisibility {
  visible: boolean;
  /** Show now and re-arm. */
  reset: () => void;
  /** Hide now, skipping the wait — for a pointer leaving the surface entirely. */
  hide: () => void;
  /** Hold visible until released. Keyed, because two independent holds (a slider
   *  drag and an open popover) must not cancel each other: whoever released last
   *  would otherwise un-hold the other one. */
  pin: (key: string, on: boolean) => void;
}

/**
 * "Fade out when nothing is happening, come back on movement."
 *
 * Written three times before this — the fullscreen control bar, the video
 * theater overlay, and the Now Playing view's corner buttons — with the copies
 * already drifting on whether a pause holds the surface up. The gates that
 * genuinely differ per host are parameters (`enabled`, `hold`, `pin`); the
 * timer, the listener and their cleanup are not.
 */
export function useIdleVisibility({
  enabled = true,
  hold = false,
  getTarget,
  timeoutMs = DEFAULT_IDLE_MS,
}: IdleVisibilityOptions): IdleVisibility {
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<number>(0);
  const pinsRef = useRef<Set<string>>(new Set());
  const getTargetRef = useRef(getTarget);
  useAssignRef(getTargetRef, getTarget);

  /** Would an idle expiry be allowed to hide the surface right now? */
  const canHide = useCallback(
    () => enabled && !hold && pinsRef.current.size === 0,
    [enabled, hold],
  );

  const reset = useCallback(() => {
    setVisible(true);
    clearTimeout(timerRef.current);
    if (canHide()) {
      timerRef.current = window.setTimeout(() => setVisible(false), timeoutMs);
    }
  }, [canHide, timeoutMs]);

  const hide = useCallback(() => {
    clearTimeout(timerRef.current);
    if (canHide()) setVisible(false);
  }, [canHide]);

  const pin = useCallback((key: string, on: boolean) => {
    if (on) {
      pinsRef.current.add(key);
      clearTimeout(timerRef.current);
      setVisible(true);
    } else {
      pinsRef.current.delete(key);
      reset();
    }
  }, [reset]);

  // Re-show and re-arm whenever a gate flips — play state, or entering
  // fullscreen. Disabling shows the surface and leaves it up, which is what a
  // host that stopped auto-hiding wants.
  useEffect(() => { reset(); }, [reset]);

  useEffect(() => {
    if (!enabled) return;
    const el = getTargetRef.current();
    if (!el) return;
    const onMove = () => reset();
    el.addEventListener("mousemove", onMove);
    return () => el.removeEventListener("mousemove", onMove);
  }, [enabled, reset]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { visible, reset, hide, pin };
}
