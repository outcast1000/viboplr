import { useState } from "react";
import type { UpdateError } from "../hooks/useAppUpdater";
import type { UpdateNotice } from "../utils/updateNotice";
import { UpdateProgress } from "./UpdateProgress";
import "./UpdateNoticeBanner.css";

export interface UpdateNoticeBannerProps {
  notice: UpdateNotice;
  /** The app update is downloading/installing right now. */
  installing: boolean;
  /** Byte progress of that download, when the app notice is installing. */
  progress: { downloaded: number; total: number } | null;
  /**
   * Why the last attempt from *this* banner failed. Without it the strip just
   * reverts to "Update & restart" and the explanation lives only in Settings —
   * i.e. behind the page this banner exists to save the user from opening.
   */
  error: UpdateError | null;
  /** Install the app update (and relaunch), or update every extension. */
  onUpdate: () => void;
  /** Open the surface that owns the detail: Settings, or Extensions. */
  onOpenDetails: () => void;
  /** Hide this notice until its signature changes. */
  onDismiss: () => void;
}

/**
 * "A new version is ready" — a strip at the top of the content column.
 *
 * Deliberately **not a toast**: toasts auto-dismiss after 4.5s, and the notice
 * a user most needs is the one from the background check they weren't watching
 * (the same reasoning behind the persistent `UpdateErrorRow` and the queue's
 * backfill row). Deliberately **not a modal** either — nothing here is urgent
 * enough to interrupt playback, and this app's modals can't be dismissed by
 * clicking away.
 *
 * It takes layout rather than overlaying, so it can never cover a control; the
 * cost is that the view below shifts down once, which is why dismissal is
 * remembered per release (see `utils/updateNotice.ts`).
 */
export function UpdateNoticeBanner({
  notice,
  installing,
  progress,
  error,
  onUpdate,
  onOpenDetails,
  onDismiss,
}: UpdateNoticeBannerProps) {
  const [notesOpen, setNotesOpen] = useState(false);
  const isApp = notice.kind === "app";
  // Only an install failure belongs here. A failed *check* is about a release
  // this banner can't be announcing (it has one, so the check succeeded at
  // some point) — that one stays in Settings, where its retry lives.
  const failure = isApp && error?.stage === "install" ? error : null;
  // Release notes for the app; the affected extension names otherwise. Both
  // answer "what am I being asked to install?", which the Settings row never
  // did — the updater has always fetched the notes and shown them nowhere.
  // A single extension is already named in the headline, so it gets no
  // disclosure that would only repeat it.
  const names = notice.names ?? [];
  const details = isApp ? notice.body : names.length > 1 ? names.join(", ") : undefined;

  return (
    <div className={`update-notice ${failure ? "has-error" : ""}`} role="status" aria-live="polite">
      <div className="update-notice-row">
        <span className="update-notice-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </span>

        <span className="update-notice-title">{notice.title}</span>

        {details && (
          <button
            type="button"
            className="update-notice-link"
            onClick={() => setNotesOpen((o) => !o)}
            aria-expanded={notesOpen}
          >
            {isApp ? "What's new" : "Which ones"}
            <span className={`update-notice-caret ${notesOpen ? "is-open" : ""}`} aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </span>
          </button>
        )}

        <div className="update-notice-actions">
          {installing ? (
            <UpdateProgress progress={progress} />
          ) : (
            <>
              <button type="button" className="ds-btn ds-btn--primary ds-btn--sm" onClick={onUpdate}>
                {failure ? "Try again" : isApp ? "Update & restart" : "Update all"}
              </button>
              <button type="button" className="ds-btn ds-btn--ghost ds-btn--sm" onClick={onOpenDetails}>
                {isApp ? "Details" : "Extensions"}
              </button>
            </>
          )}
          {/* No dismiss during an install: the row is reporting a download in
              flight, and hiding it would leave the user with no progress. */}
          {!installing && (
            <button
              type="button"
              className="update-notice-close"
              onClick={onDismiss}
              title="Dismiss until the next release"
              aria-label="Dismiss update notice"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {failure && <div className="update-notice-error">{failure.message}</div>}

      {notesOpen && details && <div className="update-notice-notes">{details}</div>}
    </div>
  );
}
