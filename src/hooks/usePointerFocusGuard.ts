import { useCallback, useRef } from "react";

/**
 * Tells a focus caused by a mouse press apart from one caused by the keyboard,
 * for a focusable listbox that seeds its keyboard cursor on focus.
 *
 * The listboxes (`TrackList`, the plugin `track-row-list`) put the cursor on the
 * first row when they gain focus, and keep the cursor's row scrolled into view.
 * That is right for Tab, and wrong for a click: WebKit never focuses a clicked
 * `<button>`, so pressing a row's hover action focuses the LISTBOX instead. The
 * cursor then landed on row 0 and scrolled it into view — the list jumped to the
 * top between mousedown and mouseup, the click ended over a different element,
 * and the button's action never ran (seen as "Download scrolls the list up and
 * does nothing" unless a row was already selected).
 *
 * Wire `onMouseDownCapture` onto the listbox — CAPTURE, because the hover
 * buttons stop their mousedown from bubbling — and check `isPointerFocus()` in
 * its focus handler. mousedown precedes the focus it causes, and the flag clears
 * on the next task, so a later Tab-in is never mistaken for a click.
 */
export function usePointerFocusGuard(): { onMouseDownCapture: () => void; isPointerFocus: () => boolean } {
  const pressedRef = useRef(false);
  const onMouseDownCapture = useCallback(() => {
    pressedRef.current = true;
    setTimeout(() => { pressedRef.current = false; }, 0);
  }, []);
  const isPointerFocus = useCallback(() => pressedRef.current, []);
  return { onMouseDownCapture, isPointerFocus };
}
