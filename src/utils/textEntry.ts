// Pure predicate: is this event target real text entry?
//
// The in-app shortcut handler reserves the arrow keys for transport (seek /
// volume / prev / next) and must stand down only while the user is typing. The
// test used to be `tagName === "INPUT" || tagName === "TEXTAREA"`, which counts
// every slider and checkbox as typing — so clicking the volume slider left
// focus on it and silently killed the arrow keys app-wide, with no focus ring
// to explain it (`*:focus { outline: none }` in base.css draws a ring for
// `:focus-visible` only, i.e. never for a mouse click).
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
