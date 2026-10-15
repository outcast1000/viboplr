import { isReducedMotion } from "./reducedMotion";

/**
 * Animated removal of library track rows (`TrackList` rows carry
 * `data-track-id`). Deleting tracks has no success toast — the rows going away
 * IS the feedback — so they fade out, then their neighbours slide up into the
 * gap instead of the list snapping shut.
 *
 * Cheap by construction (frontend.md → "New motion must be cheap"): opacity and
 * transform only, one-shot, and no `height` animation — the gap is closed by a
 * FLIP of the surviving rows near the viewport.
 *
 * The neighbour slide is timed off the rows' actual DOM removal (a
 * MutationObserver on each list, whose callback runs before paint), not off a
 * state update: a deleted track leaves different lists at different times —
 * the Library tab drops it in an effect (`searchDeletedBatch`), a detail page
 * on its own refresh — and only the DOM knows when each one did.
 *
 * Usage: `const settle = await fadeOutTrackRows(ids)`, then commit the removal,
 * then `settle()` (arms the observers). Resolves at once — and `settle` is a
 * no-op — under reduced motion, without `Element.animate` (jsdom), or when no
 * row for those ids is on screen.
 */
const FADE_MS = 160;
const SLIDE_MS = 240;
const SLIDE_EASE = "cubic-bezier(0.22, 1, 0.36, 1)"; // --ease-out-quint
/** Give up on a list that never drops its row (its own refresh failed, or it
 *  legitimately still shows the track): un-hide the row and stop watching. */
const WATCH_MS = 3000;
/** Rows measured per list — enough to cover the viewport plus the gap. */
const MAX_NEIGHBOURS = 120;

export async function fadeOutTrackRows(trackIds: number[]): Promise<() => void> {
  const noop = () => {};
  if (trackIds.length === 0 || isReducedMotion() || typeof document === "undefined") return noop;
  const viewportH = window.innerHeight;
  // A row with no box is in a list that isn't displayed — the always-mounted
  // Library view sits under `display: none` while a detail page is open, and
  // its rows report an all-zero rect that would otherwise pass as "on screen"
  // (then fly in from the top when the user switches back). Such lists are
  // left alone; they drop the row on their own refresh, as before.
  const onScreen = (r: DOMRect, slack: number) =>
    (r.width > 0 || r.height > 0) && r.bottom >= -slack && r.top <= viewportH + slack;
  const ids = new Set(trackIds.map(String));
  const leaving = Array.from(document.querySelectorAll<HTMLElement>("[data-track-id]"))
    .filter((el) => ids.has(el.dataset.trackId ?? "") && onScreen(el.getBoundingClientRect(), viewportH));
  if (leaving.length === 0 || typeof leaving[0].animate !== "function") return noop;
  if (!leaving.some((el) => onScreen(el.getBoundingClientRect(), 0))) return noop;

  const lists = new Map<HTMLElement, { gone: HTMLElement[]; tops: Map<HTMLElement, number> }>();
  for (const el of leaving) {
    const parent = el.parentElement;
    if (!parent) continue;
    if (!lists.has(parent)) lists.set(parent, { gone: [], tops: new Map() });
    lists.get(parent)!.gone.push(el);
  }

  const fades = leaving.map((el) =>
    el.animate(
      [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-12px)" }],
      { duration: FADE_MS, easing: "ease-in", fill: "forwards" },
    ),
  );
  await Promise.race([
    // Fire-and-forget: a fade only rejects when it is cancelled, which is not an
    // error worth logging; the timeout below bounds the wait either way.
    Promise.all(fades.map((a) => a.finished.catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, FADE_MS + 100)),
  ]);

  // Per list: where the surviving rows sit now — measured after the fade, just
  // before the caller commits, so a scroll during the fade can't skew the slide.
  // Every child counts (a "Not in library" MissingRow must glide with the rows
  // around it, not snap through them). Rows above the first deleted one don't
  // move, and children are in document order, so the scan starts there and
  // stops once it is past the screen plus the gap.
  for (const [parent, entry] of lists) {
    const gap = entry.gone.reduce((h, el) => h + el.getBoundingClientRect().height, 0);
    const children = Array.from(parent.children) as HTMLElement[];
    const first = Math.min(...entry.gone.map((el) => children.indexOf(el)).filter((i) => i >= 0));
    for (let i = Math.max(0, first); i < children.length && entry.tops.size < MAX_NEIGHBOURS; i++) {
      const row = children[i];
      if (entry.gone.includes(row)) continue;
      const r = row.getBoundingClientRect();
      if (r.top > viewportH + gap) break;
      if (onScreen(r, gap)) entry.tops.set(row, r.top);
    }
  }

  return () => {
    for (const [parent, { gone, tops }] of lists) {
      // FLIP: the survivors are already in their new places; start each from
      // where it was and let it glide up. Runs before paint, so no jump shows.
      const slide = () => {
        for (const [row, oldTop] of tops) {
          if (!row.isConnected) continue;
          const dy = oldTop - row.getBoundingClientRect().top;
          if (Math.abs(dy) < 1) continue;
          row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: SLIDE_MS, easing: SLIDE_EASE });
        }
      };
      if (!gone.some((el) => el.isConnected)) { slide(); continue; } // already committed
      const observer = new MutationObserver(() => {
        if (gone.some((el) => el.isConnected)) return; // not every deleted row is out yet
        observer.disconnect();
        clearTimeout(timer);
        slide();
      });
      observer.observe(parent, { childList: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        // This list kept the row: show it again rather than leave a blank gap.
        fades.forEach((a, i) => { if (gone.includes(leaving[i]) && leaving[i].isConnected) a.cancel(); });
      }, WATCH_MS);
    }
  };
}
