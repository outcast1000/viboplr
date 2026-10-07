import { useState } from "react";
import type { Cue, CueCredit } from "../utils/cueSheet";
import { activeCueIndex, cueCredit } from "../utils/cueSheet";
import { usePlaybackPosition } from "../playback/positionStore";
import "./CueOverlay.css";

/** The cue sheet's current card, over the Now Playing art column. One card at
 *  a time (see `activeCueIndex`); keyed by index so each new cue mounts fresh
 *  and runs the enter animation. Subscribed to the position tick at this leaf
 *  so only the overlay re-renders at ~4 Hz, not the whole view. */
export function CueOverlay({ cues, author, timingNote }: { cues: Cue[]; author?: string | null; timingNote?: string | null }) {
  const positionSecs = usePlaybackPosition();
  const idx = activeCueIndex(cues, positionSecs);
  if (idx < 0) return null;
  return (
    <div className="np-cues" aria-live="polite">
      <CueCard key={idx} cue={cues[idx]} credit={cueCredit(author, timingNote)} />
    </div>
  );
}

function CueCard({ cue, credit }: { cue: Cue; credit: CueCredit | null }) {
  // A dead image URL drops the picture, not the card — the caption still says
  // something worth reading.
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = cue.kind === "image" && !!cue.imageUrl && !imageFailed;
  if (cue.kind === "image" && !showImage && !cue.caption) return null;
  return (
    <div className={`np-cue np-cue--${cue.kind}`}>
      {showImage && (
        <img
          className="np-cue-image"
          src={cue.imageUrl}
          alt={cue.caption ?? ""}
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      )}
      <div className="np-cue-body">
        {cue.label && <div className="np-cue-label">{cue.label}</div>}
        {cue.text && (
          <div className="np-cue-text">{cue.kind === "quote" ? `“${cue.text}”` : cue.text}</div>
        )}
        {cue.caption && <div className="np-cue-caption">{cue.caption}</div>}
        {credit && <div className="np-cue-source" title={credit.title}>{credit.text}</div>}
      </div>
    </div>
  );
}
