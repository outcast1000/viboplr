import { useEffect, useState } from "react";

interface Props {
  error: string;
  trackTitle: string | null;
  onDismiss: () => void;
  onSkip: () => void;
  /** Opens the diagnostic report, prefilled with this failure. */
  onReportProblem: () => void;
}

const AUTO_SKIP_SECS = 15;

export default function PlaybackErrorModal({ error, trackTitle, onDismiss, onSkip, onReportProblem }: Props) {
  const [remaining, setRemaining] = useState(AUTO_SKIP_SECS);
  const [reported, setReported] = useState(false);

  // Hold the auto-skip once the user opens a report: auto-skipping this dialog
  // out from under them would take the failure details with it.
  const paused = reported;

  useEffect(() => {
    if (paused) return;
    const interval = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(interval);
          onSkip();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [paused]);

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Playback Failed</h2>
        {trackTitle && <p className="playback-error-track">{trackTitle}</p>}
        <p className="playback-error-message">{error}</p>
        {!paused && (
          <p className="playback-error-countdown">
            Skipping to next track in {remaining}s...
          </p>
        )}
        <div className="ds-modal-actions">
          <button
            className="ds-btn ds-btn--ghost"
            onClick={() => { setReported(true); onReportProblem(); }}
          >
            Report a problem
          </button>
          <button className="ds-btn ds-btn--ghost" onClick={onDismiss}>
            Dismiss
          </button>
          <button className="ds-btn ds-btn--primary" onClick={onSkip}>
            Skip Now
          </button>
        </div>
      </div>
    </div>
  );
}
