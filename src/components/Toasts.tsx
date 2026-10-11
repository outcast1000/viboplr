import type { Toast } from "../hooks/useToasts";

interface Props {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

/** Rendered inside App's `.notice-corner`, above the assistant activity pill —
 *  one column for both, so they can never overlap. Both share `.notice-surface`
 *  and the `notice-tone--*` dot/border vocabulary; the shape is what differs
 *  (a card for a message, a capsule for the assistant's standing status).
 *  Newest toast sits lowest, nearest the corner. */
export function Toasts({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast notice-surface notice-tone--${t.kind}${t.leaving ? " toast--leaving" : ""}`}
          role={t.kind === "error" ? "alert" : undefined}
        >
          <span className="notice-dot" aria-hidden="true" />
          {/* The message itself still dismisses — it's the biggest target. */}
          <button type="button" className="toast-message" onClick={() => onDismiss(t.id)} title="Dismiss">
            {t.message}
            {t.count > 1 && <span className="toast-count">×{t.count}</span>}
          </button>
          <span className="toast-tools">
            {t.action && (
              <button
                type="button"
                className="ds-btn ds-btn--primary ds-btn--sm"
                onClick={() => {
                  onDismiss(t.id);
                  t.action?.run();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="toast-close" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
