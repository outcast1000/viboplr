import type { Track } from "../types";

interface DuplicateWarningModalProps {
  duplicates: Track[];
  totalCount: number;
  onAllowAll: () => void;
  onSkipDuplicates: () => void;
  onCancel: () => void;
}

export function DuplicateWarningModal({
  duplicates, totalCount, onAllowAll, onSkipDuplicates, onCancel,
}: DuplicateWarningModalProps) {
  const newCount = totalCount - duplicates.length;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <h2>Duplicate Tracks</h2>
        <p>
          {duplicates.length} of {totalCount} track{totalCount !== 1 ? "s" : ""} already
          {duplicates.length === 1 ? " exists" : " exist"} in the playlist:
        </p>
        <ul className="duplicate-list">
          {duplicates.slice(0, 10).map(t => (
            <li key={t.id}>
              <span className="duplicate-title">{t.title}</span>
              {t.artist_name && <span className="duplicate-artist"> — {t.artist_name}</span>}
            </li>
          ))}
          {duplicates.length > 10 && (
            <li className="duplicate-more">…and {duplicates.length - 10} more</li>
          )}
        </ul>
        <div className="modal-actions">
          <button className="modal-btn" onClick={onAllowAll}>Allow All</button>
          {newCount > 0 && (
            <button className="modal-btn modal-btn-primary" onClick={onSkipDuplicates}>
              Add {newCount} New Only
            </button>
          )}
          <button className="modal-btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
