import type { ReactElement } from "react";
import type { ToastKind } from "../hooks/useToasts";

const PATHS: Record<ToastKind, ReactElement> = {
  info: (
    <>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M8 7.3v3.6M8 5.1v.1" />
    </>
  ),
  success: (
    <>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M5.3 8.2l1.9 1.9 3.6-3.8" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2.2l6.2 11H1.8z" />
      <path d="M8 6.6v3M8 11.5v.1" />
    </>
  ),
  error: (
    <>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" />
    </>
  ),
};

/**
 * A notification's kind as an icon in a tinted tile — the toast and the list
 * rows. The colour comes from the enclosing `.notice-tone--*` (App.css), so the
 * tile follows the skin; the shape says the kind even without colour.
 */
export function NoticeIcon({ kind }: { kind: ToastKind }) {
  return (
    <span className="notice-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {PATHS[kind]}
      </svg>
    </span>
  );
}
