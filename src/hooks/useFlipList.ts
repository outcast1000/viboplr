import { useLayoutEffect, useRef } from "react";

/**
 * FLIP reposition animation for a list whose items carry a stable `data-flip-key`.
 *
 * On every commit it measures each item's position, and when the list's key
 * order actually changed it instantly translates moved items back to their old
 * spot (before paint) then releases them with a transition — so reorders,
 * insertions and removals settle physically instead of snapping. New items (no
 * previous position) are left to their own CSS entrance; removed items just
 * vanish while their neighbours slide up to close the gap.
 *
 * Crucially, when the key order is unchanged we only refresh the baseline and
 * never animate. A plain re-render (current-track marker moving on Next, the
 * inline resolving spinner swapping in, a selection highlight) can nudge a
 * row's height by a pixel or two; without this gate FLIP would misread that
 * nudge as a move and play a jarring up/down slide on every Next click.
 *
 * Guards: honours `prefers-reduced-motion`, and bails on long lists so we never
 * measure/animate hundreds of nodes (the queue is not virtualised).
 */
const MAX_ANIMATED = 150;
const FLIP_EASE = "cubic-bezier(0.22, 1, 0.36, 1)"; // --ease-out-quint
const FLIP_MS = 260;

function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function useFlipList(containerRef: React.RefObject<HTMLElement | null>) {
  const prevTops = useRef<Map<string, number>>(new Map());
  const prevOrder = useRef<string[]>([]);
  const reduced = useRef(
    typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const items = Array.from(el.querySelectorAll<HTMLElement>("[data-flip-key]"));
    const order: string[] = [];
    const newTops = new Map<string, number>();
    for (const it of items) {
      const key = it.dataset.flipKey;
      if (key == null) continue;
      order.push(key);
      newTops.set(key, it.getBoundingClientRect().top);
    }

    // Only animate on a genuine reorder/insert/remove. An unchanged key order
    // (Next click, resolving-spinner swap, selection change) just refreshes the
    // baseline so the next real reorder still measures from the settled layout.
    const orderChanged = !sameOrder(order, prevOrder.current);

    if (orderChanged && !reduced.current && items.length <= MAX_ANIMATED) {
      for (const it of items) {
        const key = it.dataset.flipKey;
        if (key == null) continue;
        const oldTop = prevTops.current.get(key);
        if (oldTop === undefined) continue; // freshly mounted — let CSS handle entry
        const dy = oldTop - newTops.get(key)!;
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
    }

    prevTops.current = newTops;
    prevOrder.current = order;
  });
}
