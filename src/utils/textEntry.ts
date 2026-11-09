// Pure predicate: is this event target real text entry?
//
// The in-app shortcut handler reserves the arrow keys for transport (seek /
// volume / prev / next) and must stand down only while the user is typing. The
// test used to be `tagName === "INPUT" || tagName === "TEXTAREA"`, which counts
// every slider and checkbox as typing — so clicking the volume slider left
// focus on it and silently killed the arrow keys app-wide, with no focus ring
// to explain it (base.css draws no focus ring at all).
//
// A control is not a text field. Only these are:
//   - <textarea>
//   - a genuinely editable [contenteditable] host
//   - <input> whose type accepts typed characters

// Everything an <input> can be that is a control rather than a text field.
// Listed as an exclusion set, not an inclusion set: the text-ish types are
// open-ended (text, search, url, email, tel, password, number, date, …) and a
// missing one would re-break typing, while a missing control type only means
// the arrows stay transport keys — the intended default.
const CONTROL_INPUT_TYPES = new Set([
  "range",
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "color",
  "file",
  "image",
]);

export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  // `closest` rather than a tag check on the target itself: a keydown inside a
  // rich contenteditable lands on the inner node, not on the editable host.
  const field = el.closest("input, textarea, [contenteditable]");
  if (!field) return false;
  if (field.tagName === "TEXTAREA") return true;
  if (field.tagName === "INPUT") {
    // `.type` normalizes an absent or unknown attribute to "text".
    return !CONTROL_INPUT_TYPES.has((field as HTMLInputElement).type);
  }
  // `[contenteditable]` matches contenteditable="false" too, so resolve the
  // value. Deliberately not `.isContentEditable`, which jsdom does not
  // implement — it yields `undefined` there, so the predicate would silently
  // return a non-boolean and could never be tested. The attribute is editable
  // when empty, "true" or "plaintext-only"; only "false" opts a subtree out,
  // and `closest` finding a "false" host inside an editable one is the right
  // answer for that subtree.
  const value = field.getAttribute("contenteditable")?.toLowerCase() ?? "";
  return value !== "false";
}

// Modifier chords a text field uses to move the caret: Cmd+←/→/↑/↓ jump to the
// start / end of the line or field on macOS, Ctrl+←/→ jump by word on Windows
// and Linux. The app binds Cmd/Ctrl+←/→ to previous / next track, so without
// this a user editing a search box skipped tracks instead of moving the caret.
const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

/** True when a keydown in a text field is the field's own editing key, so an
 *  app shortcut must leave it alone. Plain keys are already covered by the
 *  caller's "not while typing" gate; this is for the Cmd/Ctrl chords. */
export function textFieldOwnsKey(e: { key: string }, inTextField: boolean): boolean {
  return inTextField && CARET_KEYS.has(e.key);
}

/** The window's unmodified transport keys a widget may navigate with. */
const WIDGET_NAV_KEYS = new Set([" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * True when a widget already handled this navigation key — it called
 * `preventDefault` on it. The window's transport shortcuts (Space = pause,
 * ←/→ = seek, ↑/↓ = volume) listen on `window`, so they run in the bubble
 * phase AFTER every React handler below; without this one keypress both moved
 * a widget's cursor and seeked the track.
 *
 * Keyed on what the widget DID, not on where focus is: an earlier version
 * matched a `data-keynav` attribute, which also swallowed keys the widget
 * ignored (Space on the tree's loading row didn't pause; ↑/↓ on the split
 * divider, which only handles ←/→, didn't change the volume). A widget opts in
 * by calling `preventDefault` exactly on the keys it acts on.
 *
 * This reaches every such widget, not only the ones it was written for: the
 * plugin `tree` and `split` divider, and also `TrackList` and the plugin
 * `track-row-list` (listbox cursor: ↑/↓/Home/End, Space toggles selection)
 * and `EqBarControl` / `EqCurve` (slider steps). Each of those used to act AND
 * let the window seek, change the volume or pause on the same keypress.
 */
export function widgetHandledKey(e: { key: string; defaultPrevented: boolean }): boolean {
  return e.defaultPrevented && WIDGET_NAV_KEYS.has(e.key);
}
