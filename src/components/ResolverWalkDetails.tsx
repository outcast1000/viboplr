import type { FailureDetails } from "../playback/trackFailures";
import "./PlaybackFailureModal.css";

interface Props {
  track: { title: string; artist_name: string | null };
  /** The bold line under the track ("yt-dlp found no match"); omitted when the
   *  dialog title already says it. */
  headline?: string;
  explanation: string;
  rows: FailureDetails["rows"];
  attempts: FailureDetails["attempts"];
}

/**
 * The body both playback dialogs share — "Couldn't play this track"
 * (`PlaybackFailureModal`) and "Played from X" (`PlaybackSourceModal`): the
 * track, what happened, the facts as rows, and every source the resolver chain
 * asked, in order. One renderer, so the two can't drift.
 */
export function ResolverWalkDetails({ track, headline, explanation, rows, attempts }: Props) {
  return (
    <>
      <p className="playback-failure-track">
        {track.title}
        {track.artist_name && <span className="playback-failure-artist"> — {track.artist_name}</span>}
      </p>
      {headline && <p className="playback-failure-headline">{headline}</p>}
      <p className="playback-failure-explanation">{explanation}</p>

      <dl className="playback-failure-rows">
        {rows.map((row) => (
          <div className="playback-failure-row" key={row.label}>
            <dt>{row.label}</dt>
            <dd className={row.code ? "playback-failure-code" : undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>

      {attempts.length > 0 && (
        <>
          <h3 className="playback-failure-subtitle">Sources tried</h3>
          <ol className="playback-failure-attempts">
            {attempts.map((a, i) => (
              <li key={`${a.name}-${i}`} className={a.found ? "is-found" : undefined}>
                <span className="playback-failure-attempt-name">{a.name}</span>
                <span className="playback-failure-attempt-outcome">{a.outcome}</span>
                {a.detail && <span className="playback-failure-attempt-detail playback-failure-code">{a.detail}</span>}
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}
