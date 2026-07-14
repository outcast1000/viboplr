import { useEffect, useState } from "react";

interface MpvSuggestion {
  /** libmpv isn't loaded yet, so the button must download the engine first. */
  needsInstall: boolean;
  /** Download in progress — pauses auto-skip and disables the button. */
  installing: boolean;
  onEnable: () => void;
}

interface Props {
  error: string;
  trackTitle: string | null;
  onDismiss: () => void;
  onSkip: () => void;
  onSearchYoutube?: () => void;
  /** When set, offer the native mpv engine as a fix for this format error. */
  mpvSuggestion?: MpvSuggestion | null;
}

const AUTO_SKIP_SECS = 15;

export default function PlaybackErrorModal({ error, trackTitle, onDismiss, onSkip, onSearchYoutube, mpvSuggestion }: Props) {
  const [remaining, setRemaining] = useState(AUTO_SKIP_SECS);

  // Hold the auto-skip while the engine is downloading — skipping mid-install
  // would throw away the file the user just asked us to make playable.
  const paused = !!mpvSuggestion?.installing;

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
        {mpvSuggestion && (
          <div className="playback-error-mpv">
            <p className="playback-error-mpv-hint">
              The mpv engine plays formats the built-in player can’t — FLAC, OPUS, ALAC and more.
            </p>
            <button
              className="ds-btn ds-btn--primary"
              onClick={mpvSuggestion.onEnable}
              disabled={mpvSuggestion.installing}
            >
              {mpvSuggestion.installing
                ? "Downloading engine…"
                : mpvSuggestion.needsInstall
                  ? "Install mpv engine & play"
                  : "Play with mpv engine"}
            </button>
          </div>
        )}
        {!paused && (
          <p className="playback-error-countdown">
            Skipping to next track in {remaining}s...
          </p>
        )}
        <div className="ds-modal-actions">
          {onSearchYoutube && (
            <button className="ds-btn ds-btn--ghost" onClick={onSearchYoutube}>
              Search on YouTube
            </button>
          )}
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
