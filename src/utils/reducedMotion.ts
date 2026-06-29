// Shared "reduce motion" state. Motion is reduced when EITHER the OS accessibility
// setting (`prefers-reduced-motion: reduce`) is on OR the in-app toggle has set the
// `data-reduce-motion` attribute on the document root. The CSS guard in base.css
// keys off both; JS-driven animations (the Now Playing marquee, FLIP list reorder)
// call `isReducedMotion()` and subscribe to changes via `subscribeReducedMotion`.

const ATTR = "data-reduce-motion";
const EVENT = "viboplr:reduce-motion-change";

/** True when motion should be reduced — OS preference OR the in-app toggle. */
export function isReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  const osReduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const appReduced =
    typeof document !== "undefined" && document.documentElement.hasAttribute(ATTR);
  return osReduced || appReduced;
}

/** Apply (or clear) the in-app reduce-motion override and notify subscribers so
 *  JS-driven animations update live when the user toggles the setting. */
export function applyReduceMotionAttr(on: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (on) root.setAttribute(ATTR, "true");
  else root.removeAttribute(ATTR);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

/** Subscribe to reduce-motion changes (OS preference flips + in-app toggle).
 *  Returns an unsubscribe function. */
export function subscribeReducedMotion(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  mq?.addEventListener?.("change", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    mq?.removeEventListener?.("change", cb);
    window.removeEventListener(EVENT, cb);
  };
}
