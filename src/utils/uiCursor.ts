/**
 * The on-screen cursor the control API's generic input draws (`uiInput.ts`).
 * Synthetic events have no pointer, so without it a recording — or a user
 * watching their assistant work — sees buttons press themselves. It glides to
 * each target, ripples on the click and fades out once input stops. It never
 * takes pointer events and is hidden from assistive tech.
 *
 * Imperative rather than a React component, like `showcaseRedact.ts`: it is
 * driven from the control-API dispatcher, outside any render, and one element
 * appended to <body> is all it is. Styles (`.ui-cursor`) are in App.css and
 * read skin variables only.
 */

const HIDE_AFTER_MS = 1800;

let cursor: HTMLDivElement | null = null;
let position: { x: number; y: number } | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

const ARROW_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
  '<path class="ui-cursor-arrow" d="M4 2.5v17.2l4.7-4.4 3 6.6 2.9-1.3-3-6.5 6.4-.3z"/></svg>';

function reducedMotion(): boolean {
  if (document.documentElement.hasAttribute("data-reduce-motion")) return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function ensureCursor(): HTMLDivElement {
  if (cursor && cursor.isConnected) return cursor;
  const el = document.createElement("div");
  el.className = "ui-cursor";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `${ARROW_SVG}<span class="ui-cursor-ripple"></span>`;
  document.body.appendChild(el);
  cursor = el;
  return el;
}

function place(el: HTMLDivElement, x: number, y: number) {
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  position = { x, y };
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    cursor?.classList.remove("ui-cursor--shown");
    hideTimer = null;
  }, HIDE_AFTER_MS);
}

/** Show the cursor and move it to (x, y) in viewport px, resolving when it
 *  arrives. The first glide of a burst starts a little below-right of the
 *  target, so there is always visible travel. */
export async function glideCursorTo(x: number, y: number, ms: number): Promise<void> {
  const el = ensureCursor();
  if (hideTimer) clearTimeout(hideTimer);
  const shown = el.classList.contains("ui-cursor--shown");
  const duration = reducedMotion() ? 0 : ms;
  if (!shown || !position) {
    el.style.transitionDuration = "0ms";
    place(el, x + 90, y + 70);
    // Commit the start position before the transition is turned back on.
    void el.offsetWidth;
    el.classList.add("ui-cursor--shown");
  }
  el.style.transitionDuration = `${duration}ms`;
  place(el, x, y);
  if (duration > 0) await new Promise<void>((resolve) => setTimeout(resolve, duration));
  scheduleHide();
}

/** The click ripple: a one-shot transform + opacity animation. */
export function pulseCursor(): void {
  const ripple = cursor?.querySelector(".ui-cursor-ripple");
  if (!ripple) return;
  ripple.classList.remove("ui-cursor-ripple--on");
  void (ripple as HTMLElement).offsetWidth;
  ripple.classList.add("ui-cursor-ripple--on");
  scheduleHide();
}
