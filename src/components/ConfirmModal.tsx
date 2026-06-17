import { useEffect, type ReactNode } from "react";

interface Props {
  title: string;
  message: ReactNode;
  /** Class applied to the message paragraph (e.g. "delete-confirm-warning"). */
  messageClassName?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Focus the confirm button on mount (matches the old per-modal autoFocus). */
  autoFocusConfirm?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shared two-button confirm modal (Cancel + Confirm). The canonical confirm shell:
 * named confirm leaves (delete tracks/tags, remove collection, delete playlist, …)
 * delegate to this instead of re-rendering the `.ds-modal` markup. Escape cancels;
 * it does not close on overlay click, per the modal-dismiss convention.
 */
export function ConfirmModal({
  title, message, messageClassName, confirmLabel = "Confirm", cancelLabel = "Cancel",
  destructive = false, autoFocusConfirm = false, onConfirm, onCancel,
}: Props) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={e => e.stopPropagation()}>
        <h2 className="ds-modal-title">{title}</h2>
        <p className={messageClassName}>{message}</p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={`ds-btn ${destructive ? "ds-btn--danger" : "ds-btn--primary"}`}
            onClick={onConfirm}
            autoFocus={autoFocusConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
