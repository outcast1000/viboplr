import { useEffect, type ReactNode } from "react";

interface Props {
  title: string;
  message: ReactNode;
  /** Class applied to the message paragraph (e.g. "delete-confirm-warning"). */
  messageClassName?: string;
  dismissLabel?: string;
  dismissVariant?: "ghost" | "primary";
  onDismiss: () => void;
  /** Optional richer body rendered after the message (e.g. a failure list). */
  children?: ReactNode;
}

/**
 * Shared single-button alert/error modal. The canonical "something to tell you,
 * one way out" shell: error leaves (delete failure, folder error, nav error)
 * delegate to this. Escape dismisses; it does not close on overlay click, per the
 * modal-dismiss convention.
 */
export function AlertModal({
  title, message, messageClassName, dismissLabel = "OK",
  dismissVariant = "ghost", onDismiss, children,
}: Props) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onDismiss();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onDismiss]);

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={e => e.stopPropagation()}>
        <h2 className="ds-modal-title">{title}</h2>
        <p className={messageClassName}>{message}</p>
        {children}
        <div className="ds-modal-actions">
          <button className={`ds-btn ds-btn--${dismissVariant}`} onClick={onDismiss}>
            {dismissLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
