import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { CurrentToast } from "../hooks/useToasts";

interface Props {
  current: CurrentToast | null;
  onDismiss: () => void;
  onAction: (id: number) => void;
  /** Hover / focus hold the countdown; the hook owns the timer. */
  onHold: (reason: string, on: boolean) => void;
  /** "+N": the toasts this one replaced are in the list. */
  onOpenList: () => void;
}

const CloseIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/**
 * The one toast, in App's bottom-right `.notice-corner` to the left of the
 * assistant segment. It shows the **whole** message — a card that wraps, the
 * action on its own line under the text — because a truncated message was the
 * complaint. The text is selectable and clicking it does nothing; only ×
 * dismisses.
 */
export function Toasts({ current, onDismiss, onAction, onHold, onOpenList }: Props) {
  if (!current) return null;
  return (
    <ToastSlot onHold={onHold}>
      {/* Keyed by id *and* time, so a repeat ("×2") restarts its countdown line. */}
      <ToastCard key={`${current.item.id}:${current.item.at}`} current={current} onDismiss={onDismiss} onAction={onAction} onHold={onHold} onOpenList={onOpenList} />
    </ToastSlot>
  );
}

/**
 * Owns the hover hold, outside the keyed card: a repeat or a replacement
 * remounts the card under a pointer that never left, and a hold the old card
 * released would not come back until the pointer left and re-entered.
 * `display: contents`, so the corner's layout still sees the card itself.
 */
function ToastSlot({ onHold, children }: { onHold: Props["onHold"]; children: ReactNode }) {
  // Mouse-leave never fires for an element that unmounts under the pointer,
  // so the hold is released when the toast goes away entirely.
  useEffect(() => () => onHold("hover", false), [onHold]);
  return (
    <div
      style={{ display: "contents" }}
      onMouseEnter={() => onHold("hover", true)}
      onMouseLeave={() => onHold("hover", false)}
    >
      {children}
    </div>
  );
}

function ToastCard({ current, onDismiss, onAction, onHold, onOpenList }: Props & { current: CurrentToast }) {
  const ref = useRef<HTMLDivElement>(null);
  const { item, extra, durationMs, running, leaving } = current;

  // Whatever had focus inside this card goes with it, so the focus hold does too.
  useEffect(() => () => onHold("focus", false), [onHold]);

  // Shrinking into the bell needs to know where the bell is.
  useLayoutEffect(() => {
    const el = ref.current;
    if (leaving !== "bell" || !el) return;
    const bell = document.querySelector<HTMLElement>("[data-notification-bell]");
    if (!bell) return;
    const a = el.getBoundingClientRect();
    const b = bell.getBoundingClientRect();
    el.style.setProperty("--to-bell-x", `${b.left + b.width / 2 - (a.left + a.width / 2)}px`);
    el.style.setProperty("--to-bell-y", `${b.top + b.height / 2 - (a.top + a.height / 2)}px`);
  }, [leaving]);

  return (
    <div
      ref={ref}
      className={`toast notice-tone--${item.kind}${leaving ? ` toast--leave-${leaving}` : ""}`}
      role={item.kind === "error" ? "alert" : "status"}
      onFocus={() => onHold("focus", true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHold("focus", false);
      }}
    >
      <span className="notice-dot" aria-hidden="true" />
      <div className="toast-body">
        <div className="toast-message">
          {item.source && <span className="toast-source">{item.source}</span>}
          {item.message}
          {item.count > 1 && <span className="toast-count">×{item.count}</span>}
        </div>
        {item.action && (
          <div className="toast-actions">
            <button type="button" className="ds-btn ds-btn--primary ds-btn--sm" onClick={() => onAction(item.id)}>
              {item.action.label}
            </button>
          </div>
        )}
      </div>
      <span className="toast-tools">
        {extra > 0 && (
          <button type="button" className="toast-more" onClick={onOpenList} title="Open notifications" aria-label={`${extra} more — open notifications`}>
            +{extra}
          </button>
        )}
        <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss">
          <CloseIcon />
        </button>
      </span>
      <span
        className={`toast-timer${running ? "" : " toast-timer--held"}`}
        style={{ animationDuration: `${durationMs}ms` }}
        aria-hidden="true"
      />
    </div>
  );
}
