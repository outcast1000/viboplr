import type { KeyCombo, UiTarget, UiTargetRole } from "./uiControl";
import { glideCursorTo, pulseCursor } from "./uiCursor";

/**
 * The DOM half of the control API's generic input (`ui.query` / `ui.input`):
 * find an element the way a person names it, then click it, type into it or
 * press a key — with a visible cursor gliding there first, because synthetic
 * events have no pointer and a recording of fields changing by themselves
 * reads as fake. Validation is pure in `uiControl.ts`; the scope check is in
 * Rust (`handle_ui_input`).
 *
 * **Protected regions** carry `data-ui-input-protected` (Settings → AI
 * control, the Extensions view, the plugin install dialog). A target inside
 * one is refused, and so is a key press while focus is inside one: those are
 * the surfaces where a person's click is the consent or the permission, and
 * the assistant must never be able to grant itself more through them.
 * `INPUT_PROTECTED_MODALS` (`uiControl.ts`) covers the consent dialogs the
 * dispatcher can see by name.
 *
 * Every lookup degrades in jsdom (no layout, no `elementFromPoint`), so the
 * resolver is testable without a browser — see `__tests__/uiInput.test.ts`.
 */

export const PROTECTED_ATTR = "data-ui-input-protected";

const FIELD_SELECTOR = [
  "input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]):not([type=file]):not([type=color])",
  "textarea",
  "select",
  "[contenteditable=''], [contenteditable=true]",
  "[role=textbox]", "[role=combobox]", "[role=searchbox]",
].join(", ");

const ROLE_SELECTORS: Record<Exclude<UiTargetRole, "any">, string> = {
  button: "button, [role=button], input[type=button], input[type=submit], input[type=reset]",
  field: FIELD_SELECTOR,
  checkbox: "input[type=checkbox], input[type=radio], [role=checkbox], [role=switch], [role=radio]",
  link: "a[href], [role=link]",
  tab: "[role=tab]",
  option: "[role=option], [role=menuitem], [role=menuitemcheckbox]",
};

const ANY_SELECTOR = Object.values(ROLE_SELECTORS).join(", ");

export interface ElementInfo {
  role: Exclude<UiTargetRole, "any"> | "element";
  name: string;
  testId?: string;
  /** Viewport CSS pixels — the window's client area, the same rectangle a
   *  capture crops to. Multiply by `devicePixelRatio` for screen pixels. */
  rect: { x: number; y: number; width: number; height: number };
  disabled: boolean;
  protected: boolean;
}

const collapse = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function textOf(el: Element): string {
  return collapse(el.textContent);
}

/**
 * A simplified accessible name: aria-label, aria-labelledby, a field's
 * `<label>`, the element's own text, then title / placeholder. Close enough to
 * the real algorithm for the controls this app renders, and predictable —
 * which matters more to a caller than completeness.
 */
export function accessibleName(el: Element): string {
  const aria = collapse(el.getAttribute("aria-label"));
  if (aria) return aria;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const doc = el.ownerDocument;
    const text = labelledBy.split(/\s+/).map((id) => doc.getElementById(id)).filter(Boolean).map((n) => textOf(n as Element)).join(" ");
    if (collapse(text)) return collapse(text);
  }
  if (el.matches("input, textarea, select")) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      const text = collapse(Array.from(labels).map((l) => textOf(l)).join(" "));
      if (text) return text;
    }
  } else {
    const text = textOf(el);
    if (text) return text;
  }
  return collapse(el.getAttribute("title")) || collapse(el.getAttribute("placeholder"));
}

function roleOf(el: Element): ElementInfo["role"] {
  for (const [role, selector] of Object.entries(ROLE_SELECTORS) as Array<[Exclude<UiTargetRole, "any">, string]>) {
    if (el.matches(selector)) return role;
  }
  return "element";
}

/** Hidden by markup or style. Layout-free on purpose (jsdom has none);
 *  `checkVisibility` adds the CSS answer where the engine has it. */
export function isHidden(el: Element): boolean {
  if (!el.isConnected) return true;
  if (el.closest("[hidden], [inert], [aria-hidden='true']")) return true;
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === "function") return !check.call(el, { visibilityProperty: true });
  return false;
}

function isDisabled(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled === true) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  return el.closest("fieldset[disabled]") !== null;
}

export function isProtected(el: Element): boolean {
  return el.closest(`[${PROTECTED_ATTR}]`) !== null;
}

export function describeElement(el: Element): ElementInfo {
  const r = el.getBoundingClientRect();
  const info: ElementInfo = {
    role: roleOf(el),
    name: accessibleName(el),
    rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    disabled: isDisabled(el),
    protected: isProtected(el),
  };
  const testId = el.getAttribute("data-testid");
  if (testId) info.testId = testId;
  return info;
}

/** Every visible element matching the target, in document order. Names match
 *  exactly, ignoring case and runs of whitespace. */
export function findTargets(doc: Document, target: UiTarget): Element[] {
  let candidates: Element[];
  if (target.testId) {
    // Escaped by hand: jsdom has no CSS.escape.
    const id = target.testId.replace(/["\\]/g, "\\$&");
    candidates = Array.from(doc.querySelectorAll(`[data-testid="${id}"]`));
    if (target.role !== "any") candidates = candidates.filter((el) => el.matches(ROLE_SELECTORS[target.role as Exclude<UiTargetRole, "any">]));
  } else {
    const selector = target.role === "any" ? ANY_SELECTOR : ROLE_SELECTORS[target.role];
    candidates = Array.from(doc.querySelectorAll(selector));
  }
  candidates = candidates.filter((el) => !isHidden(el));
  if (target.name) {
    const want = collapse(target.name).toLowerCase();
    candidates = candidates.filter((el) => accessibleName(el).toLowerCase() === want);
  }
  return candidates;
}

function describeTarget(target: UiTarget): string {
  if (target.testId) return `testId "${target.testId}"`;
  return `${target.role === "any" ? "element" : target.role} "${target.name ?? ""}"`;
}

/** Exactly one element, or an error that tells the caller how to fix the
 *  request (several matches → their count and `index`; none → a query). */
export function resolveTarget(doc: Document, target: UiTarget): Element {
  const found = findTargets(doc, target);
  if (found.length === 0) {
    throw new Error(`no visible ${describeTarget(target)} on screen — POST /v1/ui/query lists what is there`);
  }
  if (target.index !== undefined) {
    const el = found[target.index];
    if (!el) throw new Error(`${describeTarget(target)} has ${found.length} match(es); index ${target.index} is out of range`);
    return el;
  }
  if (found.length > 1) {
    throw new Error(`${found.length} visible matches for ${describeTarget(target)} — add a role, or pick one with index (0–${found.length - 1})`);
  }
  return found[0];
}

function assertActionable(el: Element, target: UiTarget) {
  if (isProtected(el)) {
    throw new Error(`${describeTarget(target)} is in a part of the app only the user may operate (AI control settings, extensions, consent dialogs)`);
  }
  if (isDisabled(el)) throw new Error(`${describeTarget(target)} is disabled`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Bring the element into view and return where its centre is. */
async function settleOnScreen(el: Element): Promise<{ x: number; y: number }> {
  if (typeof (el as HTMLElement).scrollIntoView === "function") {
    (el as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" });
    await sleep(60);
  }
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Refuse a click whose point is covered by something else — a modal over
 *  the button, say. A real click would land on the cover, so a synthetic one
 *  that reaches the button underneath would be doing something no person
 *  could. Skipped where there is no hit-testing (jsdom). */
function assertNotCovered(el: Element, x: number, y: number, target: UiTarget) {
  const doc = el.ownerDocument;
  if (typeof doc.elementFromPoint !== "function") return;
  const hit = doc.elementFromPoint(x, y);
  if (!hit || el.contains(hit) || hit.contains(el)) return;
  if (hit.closest(".ui-cursor")) return;
  const cover = describeElement(hit);
  throw new Error(`${describeTarget(target)} is covered by ${cover.name ? `"${cover.name}"` : `a ${hit.tagName.toLowerCase()}`} — close what is on top first`);
}

// No `view` in the init: nothing here reads it, and jsdom rejects its window.
function mouse(type: string, x: number, y: number): MouseEvent {
  const init: MouseEventInit = {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
    button: 0, buttons: type.endsWith("down") ? 1 : 0, detail: 1,
  };
  if (type.startsWith("pointer") && typeof PointerEvent === "function") {
    return new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true });
  }
  return new MouseEvent(type.replace(/^pointer/, "mouse"), init);
}

const FOCUSABLE = "button, input, select, textarea, a[href], [tabindex], [contenteditable=''], [contenteditable=true]";

function dispatchClick(el: Element, x: number, y: number) {
  el.dispatchEvent(mouse("pointerdown", x, y));
  el.dispatchEvent(mouse("mousedown", x, y));
  // A real press focuses the nearest focusable element — a listbox for a
  // click on one of its rows — and that is where a following key goes.
  const focusTarget = el.closest(FOCUSABLE);
  if (focusTarget instanceof HTMLElement) focusTarget.focus({ preventScroll: true });
  el.dispatchEvent(mouse("pointerup", x, y));
  el.dispatchEvent(mouse("mouseup", x, y));
  el.dispatchEvent(mouse("click", x, y));
}

export interface InputOptions {
  /** Show and glide the cursor (off in tests). */
  cursor: boolean;
}

export async function clickTarget(doc: Document, target: UiTarget, moveMs: number, opts: InputOptions): Promise<ElementInfo> {
  const el = resolveTarget(doc, target);
  assertActionable(el, target);
  const { x, y } = await settleOnScreen(el);
  if (opts.cursor) await glideCursorTo(x, y, moveMs);
  // Re-checked after the glide: a dialog may have opened on the way.
  assertNotCovered(el, x, y, target);
  if (opts.cursor) pulseCursor();
  dispatchClick(el, x, y);
  return describeElement(el);
}

/** Write a value the way React notices it: through the prototype's setter
 *  (an own-property write would be swallowed by React's value tracker), then
 *  an `input` event. */
function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export async function typeIntoTarget(
  doc: Document,
  target: UiTarget,
  text: string,
  { replace, charMs, moveMs }: { replace: boolean; charMs: number; moveMs: number },
  opts: InputOptions,
): Promise<ElementInfo> {
  const el = resolveTarget(doc, target);
  assertActionable(el, target);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    throw new Error(`${describeTarget(target)} is not a text field — click it instead`);
  }
  if (el.readOnly) throw new Error(`${describeTarget(target)} is read-only`);
  const { x, y } = await settleOnScreen(el);
  if (opts.cursor) await glideCursorTo(x, y, moveMs);
  assertNotCovered(el, x, y, target);
  if (opts.cursor) pulseCursor();
  dispatchClick(el, x, y);
  let value = replace ? "" : el.value;
  if (replace && el.value !== "") setFieldValue(el, "");
  for (const ch of text) {
    // The field may have been replaced by a re-render (an autocomplete that
    // remounts on change): stop rather than type into a detached node.
    if (!el.isConnected) throw new Error(`${describeTarget(target)} went away while typing`);
    value += ch;
    setFieldValue(el, value);
    if (charMs > 0) await sleep(charMs);
  }
  return describeElement(el);
}

/** Press a chord on whatever has focus (the page when nothing does). Only
 *  handlers see it: the browser runs no default action for an untrusted key
 *  event, so Enter on a focused button does not click it — use click. */
export function pressKeys(doc: Document, combo: KeyCombo): { target: string } {
  const active = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
  if (active && isProtected(active)) {
    throw new Error("focus is in a part of the app only the user may operate (AI control settings, extensions, consent dialogs)");
  }
  const target = active ?? doc.body;
  const init: KeyboardEventInit = {
    key: combo.key, code: combo.code, bubbles: true, cancelable: true, composed: true,
    metaKey: combo.meta, ctrlKey: combo.ctrl, altKey: combo.alt, shiftKey: combo.shift,
  };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  return { target: active ? accessibleName(active) || active.tagName.toLowerCase() : "page" };
}

/** `ui.query`: what matches, where it is, and the viewport to map it onto. */
export function queryTargets(doc: Document, target: UiTarget, limit: number) {
  const found = findTargets(doc, target);
  const view = doc.defaultView;
  return {
    viewport: {
      width: view?.innerWidth ?? 0,
      height: view?.innerHeight ?? 0,
      devicePixelRatio: view?.devicePixelRatio ?? 1,
    },
    total: found.length,
    matches: found.slice(0, limit).map(describeElement),
  };
}
