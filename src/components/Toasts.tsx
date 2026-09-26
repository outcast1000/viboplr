import type { Toast } from "../hooks/useToasts";

interface Props {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

export function Toasts({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) =>
        t.action ? (
          // Two controls, so not one big button: the message still dismisses,
          // the action does its thing and then dismisses.
          <div key={t.id} className="toast toast--action">
            <button type="button" className="toast-message" onClick={() => onDismiss(t.id)} title="Dismiss">
              {t.message}
            </button>
            <button
              type="button"
              className="ds-btn ds-btn--primary toast-action"
              onClick={() => {
                onDismiss(t.id);
                t.action?.run();
              }}
            >
              {t.action.label}
            </button>
          </div>
        ) : (
          <button key={t.id} type="button" className="toast" onClick={() => onDismiss(t.id)} title="Dismiss">
            {t.message}
          </button>
        ),
      )}
    </div>
  );
}
