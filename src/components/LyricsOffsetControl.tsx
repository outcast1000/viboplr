import {
  LYRIC_OFFSET_STEP,
  LYRIC_OFFSET_COARSE_STEP,
  clampLyricOffset,
  formatLyricOffset,
} from "../utils/lyrics";
import "./LyricsOffsetControl.css";

interface LyricsOffsetControlProps {
  offsetSecs: number;
  onChange: (secs: number) => void;
  /** Host class, so the two surfaces can place it themselves. */
  className?: string;
}

/**
 * Nudge the synced lyrics earlier or later for the current track.
 *
 * Fetched LRC is timed against the *audio release*; a music video routinely puts
 * 10-30s of intro in front of it, and a live or remastered cut drifts by a
 * second or two. Without this the lyrics are simply wrong on those tracks and
 * there is nothing the user can do about it.
 *
 * **Positive delays** — the direction people mean by "the subtitles are early".
 * See `lyricPosition`, which owns the sign.
 *
 * Two step sizes because the two problems are different orders of magnitude: a
 * drift is fixed in halves of a second, an intro is not (30 clicks), so Shift
 * takes 5s at a time. Clicking the readout resets to zero — the offset is
 * per-track and sticky, so "undo whatever I did to this song" has to be one
 * action rather than counting clicks back.
 */
export function LyricsOffsetControl({ offsetSecs, onChange, className }: LyricsOffsetControlProps) {
  const nudge = (dir: -1 | 1, coarse: boolean) => {
    const step = coarse ? LYRIC_OFFSET_COARSE_STEP : LYRIC_OFFSET_STEP;
    onChange(clampLyricOffset(offsetSecs + dir * step));
  };
  const active = offsetSecs !== 0;

  return (
    <div className={`lyric-offset${active ? " is-active" : ""}${className ? ` ${className}` : ""}`}>
      <button
        className="lyric-offset-btn"
        onClick={(e) => nudge(-1, e.shiftKey)}
        title={`Lyrics earlier (${LYRIC_OFFSET_STEP}s · Shift ${LYRIC_OFFSET_COARSE_STEP}s)`}
        aria-label="Show lyrics earlier"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="11 17 6 12 11 7" />
          <polyline points="18 17 13 12 18 7" />
        </svg>
      </button>
      <button
        className="lyric-offset-value"
        onClick={() => onChange(0)}
        disabled={!active}
        title={active ? "Reset lyrics timing" : "Lyrics timing offset"}
        aria-label={active ? `Lyrics offset ${formatLyricOffset(offsetSecs)}. Reset.` : "Lyrics timing offset"}
      >
        {formatLyricOffset(offsetSecs)}
      </button>
      <button
        className="lyric-offset-btn"
        onClick={(e) => nudge(1, e.shiftKey)}
        title={`Lyrics later (${LYRIC_OFFSET_STEP}s · Shift ${LYRIC_OFFSET_COARSE_STEP}s)`}
        aria-label="Show lyrics later"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="13 17 18 12 13 7" />
          <polyline points="6 17 11 12 6 7" />
        </svg>
      </button>
    </div>
  );
}
