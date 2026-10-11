import { useCallback, useEffect, useRef, useState } from "react";
import { recordNotification } from "../utils/notificationLog";

export interface ToastAction {
  label: string;
  run: () => void;
}

/** How much a toast matters. Drawn with the same dot + border vocabulary as
 *  the assistant activity pill: info = accent dot, success = green dot,
 *  warning / error = the dot *and* a tinted border. */
export type ToastKind = "info" | "success" | "warning" | "error";

export const TOAST_KINDS: readonly ToastKind[] = ["info", "success", "warning", "error"];

/** A kind from untrusted input (a plugin's `showNotification` options). An
 *  unknown value — a newer plugin naming a kind this host lacks — is dropped,
 *  so the toast shows as info rather than not at all. */
export function coerceToastKind(value: unknown): ToastKind | undefined {
  return TOAST_KINDS.find((k) => k === value);
}

export interface NotifyOptions {
  /** One button that does the thing the message is about ("Start slskd"). */
  action?: ToastAction;
  /** Default `info`. An `error` stays up until the user closes it. */
  kind?: ToastKind;
}

/** What every surface that raises feedback is handed. */
export type Notify = (message: string, options?: NotifyOptions) => void;

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  /** One button that does the thing the message is about ("Start slskd").
   *  A toast carrying one stays up longer — a button that vanishes in 4.5s
   *  is a button most people never reach. */
  action?: ToastAction;
  /** How many times this same message was raised while it was on screen.
   *  A repeat bumps this (and restarts the timer) instead of stacking a copy. */
  count: number;
  /** Playing its exit animation; removed from the list after `TOAST_EXIT_MS`. */
  leaving?: boolean;
}

/** How long a toast with an action stays up. */
export const ACTION_TOAST_MS = 12000;
/** At most this many toasts on screen; a newer one pushes the oldest out. */
export const MAX_VISIBLE_TOASTS = 3;
/** Length of the exit animation (`.toast--leaving` in App.css). */
export const TOAST_EXIT_MS = 180;

/** Same toast for de-dupe purposes: same text, kind and (or no) button. */
function sameToast(t: Toast, message: string, kind: ToastKind, action?: ToastAction): boolean {
  return t.message === message && t.kind === kind && t.action?.label === action?.label;
}

/**
 * Lightweight, non-blocking notifications. `notify(message, { kind, action })`
 * shows a toast; it auto-dismisses after `timeoutMs` (longer with an action),
 * except an `error`, which stays until closed — the failure is often the one
 * thing the user must not miss, and it may land while they look elsewhere.
 * Used for fire-and-forget feedback (e.g. a small radio station) and as the
 * host implementation of the plugin `api.ui.showNotification` bridge.
 *
 * Kept quiet on purpose: an identical message already on screen is bumped
 * ("×2") rather than stacked, and no more than `MAX_VISIBLE_TOASTS` show at
 * once — the oldest non-error leaves to make room (an error only goes when
 * every toast on screen is one).
 */
export function useToasts(timeoutMs = 4500) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastsRef = useRef<Toast[]>([]);
  const idRef = useRef(0);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const commit = useCallback((next: Toast[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timersRef.current.delete(id);
  }, []);

  /** Start a toast's exit animation, then drop it. */
  const dismiss = useCallback((id: number) => {
    const current = toastsRef.current.find((t) => t.id === id);
    if (!current || current.leaving) return;
    clearTimer(id);
    commit(toastsRef.current.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    timersRef.current.set(id, setTimeout(() => {
      timersRef.current.delete(id);
      commit(toastsRef.current.filter((t) => t.id !== id));
    }, TOAST_EXIT_MS));
  }, [clearTimer, commit]);

  const schedule = useCallback((id: number, kind: ToastKind, withAction: boolean) => {
    clearTimer(id);
    if (kind === "error") return;
    timersRef.current.set(id, setTimeout(() => dismiss(id), withAction ? Math.max(timeoutMs, ACTION_TOAST_MS) : timeoutMs));
  }, [clearTimer, dismiss, timeoutMs]);

  const notify = useCallback<Notify>((message, options) => {
    // A toast is often the only feedback a fire-and-forget flow gives; the ring
    // buffer keeps a durable trace for the control API and diagnostics.
    const action = options?.action;
    const kind = options?.kind ?? "info";
    recordNotification(message, kind);

    const repeat = toastsRef.current.find((t) => !t.leaving && sameToast(t, message, kind, action));
    if (repeat) {
      // Take the newest action closure: the earlier one may describe stale state.
      commit(toastsRef.current.map((t) => (t.id === repeat.id ? { ...t, action, count: t.count + 1 } : t)));
      schedule(repeat.id, kind, !!action);
      return;
    }

    const id = ++idRef.current;
    commit([...toastsRef.current, action ? { id, message, kind, action, count: 1 } : { id, message, kind, count: 1 }]);
    schedule(id, kind, !!action);

    const visible = toastsRef.current.filter((t) => !t.leaving);
    let excess = visible.length - MAX_VISIBLE_TOASTS;
    if (excess <= 0) return;
    // Oldest first, but a dismissible toast goes before an error does — and the
    // new one always shows, even over a stack of errors.
    const older = visible.filter((t) => t.id !== id);
    const order = [...older.filter((t) => t.kind !== "error"), ...older.filter((t) => t.kind === "error")];
    for (const old of order) {
      if (excess-- <= 0) break;
      dismiss(old.id);
    }
  }, [commit, dismiss, schedule]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return { toasts, notify, dismiss };
}
