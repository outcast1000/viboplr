import { useCallback, useEffect, useRef, useState } from "react";
import { recordNotification } from "../utils/notificationLog";

export interface ToastAction {
  label: string;
  run: () => void;
}

/** How much a notification matters: the toast's dot (and, for warning and
 *  error, its border) and the colour of the bell's dot. */
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
  /** Default `info`. */
  kind?: ToastKind;
  /** Who is talking — a plugin's name, "Assistant" — shown above the message
   *  and in the list. Omitted for the app itself. */
  source?: string;
}

/** What every surface that raises feedback is handed. */
export type Notify = (message: string, options?: NotifyOptions) => void;

/** One entry in the notifications list (the bell). Every toast is one. */
export interface NotificationItem {
  id: number;
  message: string;
  kind: ToastKind;
  source?: string;
  /** Present until it has run; a done action leaves no button behind. */
  action?: ToastAction;
  /** How many times this same message was raised in a short while. A repeat
   *  bumps this (and shows the toast again) instead of adding a row. */
  count: number;
  at: number;
  /** Lights the bell's dot: an error, or an action not yet taken, that left
   *  the screen without the user dealing with it. */
  unseen: boolean;
}

/** The one toast on screen. */
export interface CurrentToast {
  item: NotificationItem;
  /** Notifications that replaced each other in this slot while it was up —
   *  the "+N" that opens the list. */
  extra: number;
  /** Total time this toast gets, for the countdown line. */
  durationMs: number;
  /** Counting down (false while held: hovered, focused, app in background). */
  running: boolean;
  /** Playing its exit: `bell` shrinks it into the bell (it lit the dot),
   *  `fade` just goes. */
  leaving: "bell" | "fade" | null;
}

/** How long each kind stays up. Nothing is sticky: a notification that
 *  matters leaves into the list and lights the bell instead. */
export const TOAST_DURATION_MS: Record<ToastKind, number> = { info: 4500, success: 4500, warning: 7000, error: 8000 };
/** How long a toast with an action stays up — a button that vanishes in 4.5s
 *  is a button most people never reach. */
export const ACTION_TOAST_MS = 12000;
/** Once a held toast is let go it gets at least this long, so it doesn't
 *  vanish the instant the pointer leaves it. */
export const RELEASE_MIN_MS = 2000;
/** Exit animations (`.toast--leave-*` in App.css); keep the durations equal. */
export const TOAST_FADE_MS = 180;
export const TOAST_TO_BELL_MS = 420;
/** The list keeps this many; the oldest drop off. */
export const NOTIFICATION_LIMIT = 50;
/** A repeat of the same message inside this window is folded into one row. */
export const REPEAT_WINDOW_MS = 15000;

/** Whether an item is worth lighting the bell for, should it leave unhandled. */
function matters(item: { kind: ToastKind; action?: ToastAction }): boolean {
  return item.kind === "error" || !!item.action;
}

function durationFor(item: NotificationItem): number {
  return item.action ? Math.max(ACTION_TOAST_MS, TOAST_DURATION_MS[item.kind]) : TOAST_DURATION_MS[item.kind];
}

/**
 * Notifications: one toast at a time over the content's bottom-right corner,
 * and every one of them kept in the list behind the bell in the caption bar.
 *
 * - **One slot.** A newer notification replaces the toast on screen and the
 *   toast shows "+N" for what it replaced, which opens the list. Stacks were
 *   what made a burst messy.
 * - **Timers wait** while the toast is hovered or focused (`hold`) and while
 *   the window is in the background, then resume with at least
 *   `RELEASE_MIN_MS` left.
 * - **Nothing is sticky.** An error or an untaken action that times out
 *   leaves into the bell and lights its dot; opening the list clears it.
 * - **Repeats fold**: the same message, kind and button inside
 *   `REPEAT_WINDOW_MS` bumps a "×N" on the existing row.
 */
export function useToasts() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [current, setCurrent] = useState<CurrentToast | null>(null);
  const [listOpen, setListOpenState] = useState(false);
  const [freshIds, setFreshIds] = useState<ReadonlySet<number>>(() => new Set());
  const itemsRef = useRef<NotificationItem[]>([]);
  const currentRef = useRef<CurrentToast | null>(null);
  const listOpenRef = useRef(false);
  const idRef = useRef(0);
  // The countdown: what's left, when it last resumed, and its timer.
  const remainingRef = useRef(0);
  const resumedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Why the countdown is held; it runs only while this is empty.
  const holdsRef = useRef(new Set<string>());

  const commitItems = useCallback((next: NotificationItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);
  const commitCurrent = useCallback((next: CurrentToast | null) => {
    currentRef.current = next;
    setCurrent(next);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const finish = useCallback(() => {
    exitTimerRef.current = null;
    commitCurrent(null);
  }, [commitCurrent]);

  /** Take the toast off the screen. `x` = the user closed it (seen); `auto` =
   *  its time ran out (an unhandled one goes into the bell); `quiet` = the list
   *  opened over it. */
  const leave = useCallback((how: "x" | "auto" | "quiet") => {
    const cur = currentRef.current;
    if (!cur || cur.leaving) return;
    clearTimer();
    const latest = itemsRef.current.find((i) => i.id === cur.item.id);
    let unseen = false;
    if (latest) {
      unseen = how === "auto" && matters(latest) && !listOpenRef.current;
      if (latest.unseen !== unseen) commitItems(itemsRef.current.map((i) => (i.id === latest.id ? { ...i, unseen } : i)));
    }
    const leaving = unseen ? "bell" : "fade";
    commitCurrent({ ...cur, item: latest ? { ...latest, unseen } : cur.item, running: false, leaving });
    exitTimerRef.current = setTimeout(finish, leaving === "bell" ? TOAST_TO_BELL_MS : TOAST_FADE_MS);
  }, [clearTimer, commitCurrent, commitItems, finish]);

  /** (Re)start or resume the countdown if nothing holds it. */
  const run = useCallback(() => {
    const cur = currentRef.current;
    if (!cur || cur.leaving) return;
    clearTimer();
    if (holdsRef.current.size > 0) {
      if (cur.running) commitCurrent({ ...cur, running: false });
      return;
    }
    resumedAtRef.current = Date.now();
    timerRef.current = setTimeout(() => leave("auto"), remainingRef.current);
    if (!cur.running) commitCurrent({ ...cur, running: true });
  }, [clearTimer, commitCurrent, leave]);

  const hold = useCallback((reason: string, on: boolean) => {
    const holds = holdsRef.current;
    if (on === holds.has(reason)) return;
    const cur = currentRef.current;
    if (on) {
      if (holds.size === 0 && cur && !cur.leaving && timerRef.current !== null) {
        remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - resumedAtRef.current));
      }
      holds.add(reason);
      clearTimer();
      if (cur?.running) commitCurrent({ ...cur, running: false });
    } else {
      holds.delete(reason);
      if (holds.size === 0) {
        remainingRef.current = Math.max(remainingRef.current, RELEASE_MIN_MS);
        run();
      }
    }
  }, [clearTimer, commitCurrent, run]);

  const show = useCallback((item: NotificationItem) => {
    if (exitTimerRef.current !== null) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    const prev = currentRef.current;
    const replacing = !!prev && !prev.leaving && prev.item.id !== item.id;
    if (replacing) {
      // Pushed off the screen before its time — if it mattered, it's unseen.
      const pushed = itemsRef.current.find((i) => i.id === prev.item.id);
      if (pushed && matters(pushed) && !pushed.unseen) {
        commitItems(itemsRef.current.map((i) => (i.id === pushed.id ? { ...i, unseen: true } : i)));
      }
    }
    const extra = replacing ? prev.extra + 1 : prev && prev.item.id === item.id && !prev.leaving ? prev.extra : 0;
    const durationMs = durationFor(item);
    remainingRef.current = durationMs;
    commitCurrent({ item, extra, durationMs, running: false, leaving: null });
    run();
  }, [commitCurrent, commitItems, run]);

  const notify = useCallback<Notify>((message, options) => {
    const kind = options?.kind ?? "info";
    const action = options?.action;
    const source = options?.source;
    // A toast is often the only feedback a fire-and-forget flow gives; the ring
    // buffer keeps a trace for the control API and diagnostics.
    recordNotification(message, kind);
    const now = Date.now();

    const repeat = itemsRef.current.find(
      (i) => i.message === message && i.kind === kind && i.action?.label === action?.label && now - i.at < REPEAT_WINDOW_MS,
    );
    if (repeat) {
      // Take the newest action closure: the earlier one may describe stale state.
      // On screen again (or in the open list), so it's seen; leaving decides afresh.
      const bumped: NotificationItem = { ...repeat, action, count: repeat.count + 1, at: now, unseen: false };
      commitItems([bumped, ...itemsRef.current.filter((i) => i.id !== repeat.id)]);
      if (!listOpenRef.current) show(bumped);
      return;
    }

    const item: NotificationItem = { id: ++idRef.current, message, kind, count: 1, at: now, unseen: false };
    if (source) item.source = source;
    if (action) item.action = action;
    commitItems([item, ...itemsRef.current].slice(0, NOTIFICATION_LIMIT));
    // With the list open, the new row is right there — no toast over it.
    if (!listOpenRef.current) show(item);
  }, [commitItems, show]);

  /** The toast's × — the user saw it, so it lights nothing. */
  const dismiss = useCallback(() => leave("x"), [leave]);

  /** Run an item's action (from the toast or the list). It counts as handled
   *  and loses its button; the toast it was on goes away. */
  const runAction = useCallback((id: number) => {
    const item = itemsRef.current.find((i) => i.id === id);
    if (!item?.action) return;
    const action = item.action;
    commitItems(itemsRef.current.map((i) => (i.id === id ? { ...i, action: undefined, unseen: false } : i)));
    if (currentRef.current?.item.id === id) leave("x");
    action.run();
  }, [commitItems, leave]);

  const setListOpen = useCallback((open: boolean) => {
    listOpenRef.current = open;
    setListOpenState(open);
    if (!open) return;
    // Opening the list is looking at everything in it; what was unseen is
    // marked out (bold) for this one look.
    setFreshIds(new Set(itemsRef.current.filter((i) => i.unseen).map((i) => i.id)));
    if (itemsRef.current.some((i) => i.unseen)) commitItems(itemsRef.current.map((i) => (i.unseen ? { ...i, unseen: false } : i)));
    leave("quiet");
  }, [commitItems, leave]);

  const remove = useCallback((id: number) => {
    commitItems(itemsRef.current.filter((i) => i.id !== id));
    if (currentRef.current?.item.id === id) leave("x");
  }, [commitItems, leave]);

  const clearAll = useCallback(() => {
    commitItems([]);
    if (currentRef.current) leave("x");
  }, [commitItems, leave]);

  // The app in the background holds the countdown: a toast that lands while
  // the user is in another window waits for them.
  useEffect(() => {
    const sync = () => hold("background", document.hidden || (typeof document.hasFocus === "function" && !document.hasFocus()));
    const onBlur = () => hold("background", true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [hold]);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    if (exitTimerRef.current !== null) clearTimeout(exitTimerRef.current);
  }, []);

  const unseen = items.filter((i) => i.unseen);
  return {
    current,
    items,
    notify,
    dismiss,
    runAction,
    hold,
    listOpen,
    setListOpen,
    freshIds,
    remove,
    clearAll,
    unseenCount: unseen.length,
    unseenError: unseen.some((i) => i.kind === "error"),
  };
}
