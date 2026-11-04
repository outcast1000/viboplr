import type { QueueTrack } from "../types";
import { describeSourceNote, type EntrySourceNote } from "../playback/trackFailures";
import { ResolverWalkDetails } from "./ResolverWalkDetails";

interface Props {
  track: QueueTrack;
  note: EntrySourceNote;
  onClose: () => void;
  /** Opens the diagnostic report, prefilled with this note. */
  onReportProblem: () => void;
}

/**
 * "Where did this come from?" — opened from a queue row's "via X" chip. The
 * playing counterpart of `PlaybackFailureModal`, sharing its body
 * (`ResolverWalkDetails`): which source played the entry and every source the
 * chain asked before it.
 */
export default function PlaybackSourceModal({ track, note, onClose, onReportProblem }: Props) {
  const details = describeSourceNote(note);
  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal playback-failure-modal" role="dialog" aria-labelledby="playback-source-title">
        <h2 className="ds-modal-title" id="playback-source-title">{details.headline}</h2>
        <ResolverWalkDetails
          track={track}
          explanation={details.explanation}
          rows={details.rows}
          attempts={details.attempts}
        />
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onReportProblem}>
            Report a problem
          </button>
          <button className="ds-btn ds-btn--primary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
