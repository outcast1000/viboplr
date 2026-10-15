// "Is anybody looking at the window?" as one app-wide switch. While the
// document is hidden (minimized, on another Space, or occluded — WKWebView maps
// occlusion to visibilityState) the root carries `data-window-hidden`, and
// base.css pauses every CSS animation under it. Decorative motion nobody can
// see is pure cost, and on a transparent window every moving pixel makes macOS
// recomposite the whole window. JS-driven motion (`useSpin`'s Web Animations)
// can't be reached by CSS, so it subscribes here instead.

const ATTR = "data-window-hidden";

type Listener = (hidden: boolean) => void;
const listeners = new Set<Listener>();
let installed = false;

function sync(): void {
  const hidden = document.hidden;
  const root = document.documentElement;
  if (hidden) root.setAttribute(ATTR, "");
  else root.removeAttribute(ATTR);
  for (const listener of listeners) listener(hidden);
}

/** Mirror the document's visibility onto the root attribute. Idempotent; call
 *  once at startup. */
export function installWindowVisibility(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", sync);
  sync();
}

/** True while nobody can see the window. */
export function isWindowHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

/** Called with the new state on every visibility change. Returns an
 *  unsubscribe function. */
export function subscribeWindowHidden(listener: Listener): () => void {
  installWindowVisibility();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
