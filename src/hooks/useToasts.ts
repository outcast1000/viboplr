import { useCallback, useRef, useState } from "react";
import { recordNotification } from "../utils/notificationLog";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  /** One button that does the thing the message is about ("Start slskd").
   *  A toast carrying one stays up longer — a button that vanishes in 4.5s
   *  is a button most people never reach. */
  action?: ToastAction;
}

/** How long a toast with an action stays up. */
export const ACTION_TOAST_MS = 12000;

/**
 * Lightweight, non-blocking notifications. `notify(message)` shows a transient
 * toast that auto-dismisses after `timeoutMs`; toasts can also be dismissed on
 * click. Used for fire-and-forget feedback (e.g. a small radio station) and as
 * the host implementation of the plugin `api.ui.showNotification` bridge.
 */
export function useToasts(timeoutMs = 4500) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback((message: string, action?: ToastAction) => {
    // A toast is often the only feedback a fire-and-forget flow gives; the ring
    // buffer keeps a durable trace for the control API and diagnostics.
    recordNotification(message);
    const id = ++idRef.current;
    setToasts((prev) => [...prev, action ? { id, message, action } : { id, message }]);
    setTimeout(() => dismiss(id), action ? Math.max(timeoutMs, ACTION_TOAST_MS) : timeoutMs);
  }, [dismiss, timeoutMs]);

  return { toasts, notify, dismiss };
}
