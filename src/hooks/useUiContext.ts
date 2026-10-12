import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { buildUiContext, uiContextAnnounceKey, uiContextKey, type UiContext, type UiContextInput } from "../utils/uiContext";
import { useAssignRef } from "./useLatestRef";

/** How long the context must hold still before a change is announced — so
 *  clicking quickly through pages is one announcement, not one per page. */
export const UI_CONTEXT_SETTLE_MS = 300;

function windowPresence() {
  return {
    visible: typeof document === "undefined" || document.visibilityState === "visible",
    focused: typeof document === "undefined" || document.hasFocus(),
  };
}

/**
 * The live `UiContext` (see utils/uiContext.ts). Written into `contextRef` on
 * every commit, for `api.ui.getContext` / the control API to read, and handed
 * to `onChange` once it has settled on a new value.
 */
export function useUiContext(
  input: Omit<UiContextInput, "windowVisible" | "windowFocused">,
  contextRef: RefObject<UiContext | null>,
  onChange: (ctx: UiContext) => void,
): UiContext {
  const [presence, setPresence] = useState(windowPresence);
  useEffect(() => {
    const update = () => setPresence((prev) => {
      const next = windowPresence();
      return prev.visible === next.visible && prev.focused === next.focused ? prev : next;
    });
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);

  const { view, entity, audioFullscreen, mini } = input;
  const ctx = buildUiContext({ view, entity, audioFullscreen, mini, windowVisible: presence.visible, windowFocused: presence.focused });
  const key = uiContextKey(ctx);
  // One object per distinct context, so consumers can compare by identity.
  const stable = useMemo(() => ctx, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useAssignRef(contextRef, stable);

  const onChangeRef = useRef(onChange);
  useAssignRef(onChangeRef, onChange);
  const announceKey = uiContextAnnounceKey(stable);
  const announcedRef = useRef<string | null>(null);
  useEffect(() => {
    if (announcedRef.current === null) {
      // The first context is the starting point, not a change.
      announcedRef.current = announceKey;
      return;
    }
    if (announcedRef.current === announceKey) return;
    const timer = setTimeout(() => {
      announcedRef.current = announceKey;
      onChangeRef.current(stable);
    }, UI_CONTEXT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [announceKey, stable]);

  return stable;
}
