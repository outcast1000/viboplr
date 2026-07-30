import { usePlaybackPosition } from "../playback/positionStore";
import { currentSyncedLineIndex, type LrcLine } from "../utils/lyrics";
import "./VideoSubtitles.css";

/**
 * Subtitle-style current synced line (+ the upcoming line, dimmer) rendered over
 * the shared <video>. Mounted as a direct child of `.video-container`, so this
 * single instance serves every video mode — the docked preview, the Now Playing
 * theater, and fullscreen — without per-surface duplication (CSS reshapes it per
 * mode).
 *
 * Subscribes to the ~4 Hz position tick at this leaf so only this line
 * re-renders. Shows nothing during the intro / instrumental gaps (no active
 * line), matching the mini-player's synced-lyrics behavior.
 */
export function VideoSubtitles({ lines }: { lines: LrcLine[] }) {
  const position = usePlaybackPosition();
  const idx = currentSyncedLineIndex(lines, position);
  const current = idx >= 0 ? lines[idx].text.trim() : "";
  if (!current) return null; // before the first line, or a blank gap line
  let next = "";
  for (let i = idx + 1; i < lines.length; i++) {
    const t = lines[i].text.trim();
    if (t) { next = t; break; }
  }
  return (
    <div className="video-subtitles">
      <div className="video-subtitle-current">{current}</div>
      {next && <div className="video-subtitle-next">{next}</div>}
    </div>
  );
}
