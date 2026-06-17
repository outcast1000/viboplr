import type { Toast } from "../hooks/useToasts";

interface Props {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

export function Toasts({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className="toast" onClick={() => onDismiss(t.id)} title="Dismiss">
          {t.message}
        </button>
      ))}
    </div>
  );
}
