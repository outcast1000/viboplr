import type { QueueTrack } from "../types";
import { describeTrackFailure, type TrackFailure } from "../playback/trackFailures";
import type { FallbackSuggestions } from "../utils/fallbackSuggestions";
import { ProviderSuggestionList } from "./ProviderSuggestionList";
import { ResolverWalkDetails } from "./ResolverWalkDetails";
import "./PlaybackFailureModal.css";

interface Props {
  track: QueueTrack;
  failure: TrackFailure;
  onClose: () => void;
  /** Plays the entry again (the queue row's own play). */
  onRetry: () => void;
  /** Opens the diagnostic report, prefilled with this failure. */
  onReportProblem: () => void;
  /** Plugins that could find a playable copy (`suggestPlaybackFallbacks`). */
  suggestions?: FallbackSuggestions | null;
  /** Opens that plugin's page in Extensions — installing or turning it on
   *  stays the user's step there. */
  onShowPlugin?: (pluginId: string) => void;
}

/**
 * "Why didn't this play?" — opened from the "Couldn't play · …" note on a queue
 * row. Read-only: what failed, where the player tried to get it from, the
 * player's own error, and every source the resolver chain asked, in order.
 */
export default function PlaybackFailureModal({
  track, failure, onClose, onRetry, onReportProblem, suggestions, onShowPlugin,
}: Props) {
  const details = describeTrackFailure(failure);
  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal playback-failure-modal" role="dialog" aria-labelledby="playback-failure-title">
        <h2 className="ds-modal-title" id="playback-failure-title">Couldn't play this track</h2>
        <ResolverWalkDetails
          track={track}
          headline={details.headline}
          explanation={details.explanation}
          rows={details.rows}
          attempts={details.attempts}
        />

        {suggestions && onShowPlugin && (
          <ProviderSuggestionList
            heading={suggestions.reason === "none-ran"
              ? "No playback fallback is on. These plugins can look for a playable copy:"
              : "None of your playback fallbacks had it. These can look too:"}
            plugins={suggestions.plugins}
            onShowPlugin={onShowPlugin}
            note="Once one is on, it joins Settings → Providers → Playback fallback; then choose Try again."
          />
        )}

        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onReportProblem}>
            Report a problem
          </button>
          <button className="ds-btn ds-btn--ghost" onClick={onClose}>
            Close
          </button>
          <button className="ds-btn ds-btn--primary" onClick={onRetry} autoFocus>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
