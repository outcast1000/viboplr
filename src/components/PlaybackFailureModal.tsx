import type { QueueTrack } from "../types";
import { describeTrackFailure, type TrackFailure } from "../playback/trackFailures";
import type { FallbackSuggestions } from "../utils/fallbackSuggestions";
import { ProviderSuggestionList } from "./ProviderSuggestionList";
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
        <p className="playback-failure-track">
          {track.title}
          {track.artist_name && <span className="playback-failure-artist"> — {track.artist_name}</span>}
        </p>
        <p className="playback-failure-headline">{details.headline}</p>
        <p className="playback-failure-explanation">{details.explanation}</p>

        <dl className="playback-failure-rows">
          {details.rows.map((row) => (
            <div className="playback-failure-row" key={row.label}>
              <dt>{row.label}</dt>
              <dd className={row.code ? "playback-failure-code" : undefined}>{row.value}</dd>
            </div>
          ))}
        </dl>

        {details.attempts.length > 0 && (
          <>
            <h3 className="playback-failure-subtitle">Sources tried</h3>
            <ol className="playback-failure-attempts">
              {details.attempts.map((a, i) => (
                <li key={`${a.name}-${i}`} className={a.found ? "is-found" : undefined}>
                  <span className="playback-failure-attempt-name">{a.name}</span>
                  <span className="playback-failure-attempt-outcome">{a.outcome}</span>
                  {a.detail && <span className="playback-failure-attempt-detail playback-failure-code">{a.detail}</span>}
                </li>
              ))}
            </ol>
          </>
        )}

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
