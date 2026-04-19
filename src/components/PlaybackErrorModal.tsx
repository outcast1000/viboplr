import { useEffect, useState } from "react";

interface Props {
  error: string;
  trackTitle: string | null;
  onDismiss: () => void;
  onSkip: () => void;
}

const AUTO_SKIP_SECS = 15;

export default function PlaybackErrorModal({ error, trackTitle, onDismiss, onSkip }: Props) {
  const [remaining, setRemaining] = useState(AUTO_SKIP_SECS);

  useEffect(() => {
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
  }, []);

  return (
    <div className="modal-overlay" onClick={onDismiss}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Playback Failed</h2>
        {trackTitle && <p className="playback-error-track">{trackTitle}</p>}
        <p className="playback-error-message">{error}</p>
        <p className="playback-error-countdown">
          Skipping to next track in {remaining}s...
        </p>
        <div className="ds-modal-actions">
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
