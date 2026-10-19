import { useEffect, useId, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  title: ReactNode;
  message: ReactNode;
  /** Class applied to the message paragraph (e.g. "delete-confirm-warning"). */
  messageClassName?: string;
  confirmLabel?: ReactNode;
  cancelLabel?: string;
  destructive?: boolean;
  /** Focus the confirm button on mount (matches the old per-modal autoFocus). */
  autoFocusConfirm?: boolean;
  /** Focus Cancel instead — for consent prompts, where the safe answer is the default. */
  autoFocusCancel?: boolean;
  /** Disables both buttons and Escape while the confirm action is in flight. */
  busy?: boolean;
  /** Fixed dialog width in px, for bodies wider than the default 380. */
  width?: number;
  /** `alertdialog` for warnings the user must read before answering. */
  role?: "dialog" | "alertdialog";
  /** Render into `document.body`, so the dialog stacks above whatever dialog or
   *  fullscreen surface raised it. */
  portal?: boolean;
  /** Optional extra content rendered between the message and the action buttons. */
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shared two-button confirm modal (Cancel + Confirm). The canonical confirm shell:
 * named confirm leaves (delete tracks/tags, remove collection, delete playlist,
 * uninstall, permission and program consent, …) delegate to this instead of
 * re-rendering the `.ds-modal` markup. Escape cancels; it does not close on
 * overlay click, per the modal-dismiss convention.
 */
export function ConfirmModal({
  title, message, messageClassName, confirmLabel = "Confirm", cancelLabel = "Cancel",
  destructive = false, autoFocusConfirm = false, autoFocusCancel = false, busy = false,
  width, role, portal = false, children, onConfirm, onCancel,
}: Props) {
  useEffect(() => {
    if (busy) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel, busy]);
  const titleId = useId();

  const dialog = (
    <div className="ds-modal-overlay">
      <div
        className="ds-modal"
        style={width ? { width } : undefined}
        role={role ?? "dialog"}
        aria-labelledby={titleId}
        onClick={e => e.stopPropagation()}
      >
        <h2 className="ds-modal-title" id={titleId}>{title}</h2>
        <p className={messageClassName}>{message}</p>
        {children}
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onCancel} disabled={busy} autoFocus={autoFocusCancel}>
            {cancelLabel}
          </button>
          <button
            className={`ds-btn ${destructive ? "ds-btn--danger" : "ds-btn--primary"}`}
            onClick={onConfirm}
            disabled={busy}
            autoFocus={autoFocusConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
  return portal ? createPortal(dialog, document.body) : dialog;
}
