import { useCallback, useRef, useState } from "react";

export interface Toast {
  id: number;
  message: string;
}

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

  const notify = useCallback((message: string) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => dismiss(id), timeoutMs);
  }, [dismiss, timeoutMs]);

  return { toasts, notify, dismiss };
}
