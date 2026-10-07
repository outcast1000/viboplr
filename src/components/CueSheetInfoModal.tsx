import { useEffect } from "react";
import { createPortal } from "react-dom";
import { cueSheetDetails, type CueSheetRow } from "../utils/cueSheet";
import "./CueSheetInfoModal.css";

/**
 * What the playing song's cue sheet records about itself: the song and copy it
 * was timed to, its kind and size, who wrote it, its version and dates.
 * Portalled to the body so the audio fullscreen overlay (z-index 999, its own
 * stacking context) can't cap it under its own layers. Escape or Close
 * dismisses; never a click on the overlay (modal convention).
 */
export function CueSheetInfoModal({ row, playingSecs, onClose }: {
  row: CueSheetRow;
  playingSecs: number | null | undefined;
  onClose: () => void;
}) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return createPortal(
    <div className="ds-modal-overlay">
      <div className="ds-modal cue-info-modal" role="dialog" aria-labelledby="cue-info-title">
        <h2 className="ds-modal-title" id="cue-info-title">Cue sheet</h2>
        <dl className="cue-info-list">
          {cueSheetDetails(row, playingSecs).map((d) => (
            <div key={d.label} className={`cue-info-row${d.warn ? " cue-info-row--warn" : ""}`}>
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onClose} autoFocus>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
