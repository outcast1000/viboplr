import { useLayoutEffect, useRef } from "react";

/**
 * FLIP reposition animation for a list whose items carry a stable `data-flip-key`.
 *
 * On every commit it measures each item's position, and when an item moved
 * since the previous commit it's instantly translated back to its old spot
 * (before paint) then released with a transition — so reorders, insertions and
 * removals settle physically instead of snapping. New items (no previous
 * position) are left to their own CSS entrance; removed items just vanish while
 * their neighbours slide up to close the gap.
 *
 * Guards: honours `prefers-reduced-motion`, and bails on long lists so we never
 * measure/animate hundreds of nodes (the queue is not virtualised).
 */
const MAX_ANIMATED = 150;
const FLIP_EASE = "cubic-bezier(0.22, 1, 0.36, 1)"; // --ease-out-quint
const FLIP_MS = 260;

export function useFlipList(containerRef: React.RefObject<HTMLElement | null>) {
  const prevTops = useRef<Map<string, number>>(new Map());
  const reduced = useRef(
    typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const items = Array.from(el.querySelectorAll<HTMLElement>("[data-flip-key]"));

    // Too many rows, or reduced motion: skip animating but keep positions fresh
    // so the next change has a correct baseline once back under the cap.
    if (reduced.current || items.length > MAX_ANIMATED) {
      const tops = new Map<string, number>();
      for (const it of items) {
        const key = it.dataset.flipKey;
        if (key != null) tops.set(key, it.getBoundingClientRect().top);
      }
      prevTops.current = tops;
      return;
    }

    const newTops = new Map<string, number>();
    for (const it of items) {
      const key = it.dataset.flipKey;
      if (key == null) continue;
      const newTop = it.getBoundingClientRect().top;
      newTops.set(key, newTop);

      const oldTop = prevTops.current.get(key);
      if (oldTop === undefined) continue; // freshly mounted — let CSS handle entry
      const dy = oldTop - newTop;
      if (Math.abs(dy) < 1) continue;

      // Invert: jump back to the old position with no transition…
      it.style.transition = "none";
      it.style.transform = `translateY(${dy}px)`;
      // …then play: release to the natural position on the next frame.
      requestAnimationFrame(() => {
        it.style.transition = `transform ${FLIP_MS}ms ${FLIP_EASE}`;
        it.style.transform = "";
      });
      // Restore CSS-driven transitions/transform once the slide finishes, so a
      // moved row's hover/background transitions aren't left clobbered.
      it.addEventListener(
        "transitionend",
        () => {
          it.style.transition = "";
          it.style.transform = "";
        },
        { once: true },
      );
    }

    prevTops.current = newTops;
  });
}
