import type { PartialStoryboard, StoryboardState } from "../hooks/useStoryboard";
import { spreadIndices, spreadTileIndices, tileStartSecs } from "../utils/storyboard";
import { StoryboardTile } from "./StoryboardTile";
import "./VideoFilmstrip.css";

/**
 * How many moments to show. The strip is a flex row, so more tiles means each is
 * narrower: 8 lands at ~105 px in the detail page's content column, which a 200 px
 * source tile covers sharply even on retina. Raising this further starts to under-use
 * the tile resolution.
 */
const STRIP_TILES = 8;

function formatTimestamp(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface VideoFilmstripProps {
  storyboard: StoryboardState;
  onFrameClick?: (timestampSecs: number) => void;
}

/**
 * The strip while the storyboard generates: frames fill in as ffmpeg extracts them
 * (`storyboard.partial`, cumulative from t=0), the rest stay pulsing placeholders.
 * Slots use the same spread the finished strip will, so a frame that appears here
 * stays put when the sheet lands. Partial frames are pinned to 16:9 (cover-cropped)
 * because the source aspect isn't known until the sheet is read — a row that mixes
 * measured frames with 16:9 placeholders would jiggle otherwise.
 */
function LoadingStrip({
  partial,
  onFrameClick,
}: {
  partial: PartialStoryboard | null;
  onFrameClick?: (timestampSecs: number) => void;
}) {
  const total = partial?.count ?? 0;
  const indices = total > 0 ? spreadIndices(total, STRIP_TILES) : [];
  const slots = indices.length > 0 ? indices.length : STRIP_TILES;

  return (
    <div className="video-filmstrip">
      {Array.from({ length: slots }, (_, k) => {
        const i = indices[k];
        const src = partial && i != null && i < partial.frames.length ? partial.frames[i] : null;
        if (!src) return <div key={k} className="video-filmstrip-placeholder" />;
        const secs = i * partial!.intervalSecs;
        return (
          <div
            key={k}
            className={`video-filmstrip-frame${onFrameClick ? " clickable" : ""}`}
            onClick={onFrameClick ? () => onFrameClick(secs) : undefined}
          >
            <img className="video-filmstrip-partial-img" src={src} alt="" />
            {onFrameClick && (
              <svg className="video-filmstrip-play" width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/>
              </svg>
            )}
            <span className="video-filmstrip-ts">{formatTimestamp(secs)}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A row of clickable moments from the track's storyboard, for jumping into a video.
 *
 * Reads tiles out of the sprite sheet the seek bar already uses rather than keeping
 * its own set of extracted frames — so it gets far more moments to choose from at no
 * extra extraction cost (see docs/seek-preview-spec.md).
 */
export function VideoFilmstrip({ storyboard, onFrameClick }: VideoFilmstripProps) {
  const { board, status } = storyboard;

  if (status === "unavailable") {
    return (
      <div className="video-filmstrip-hint">
        Install ffmpeg for video frame previews
      </div>
    );
  }

  if (status === "loading") {
    return <LoadingStrip partial={storyboard.partial} onFrameClick={onFrameClick} />;
  }

  if (!board) return null;
  const indices = spreadTileIndices(board, STRIP_TILES);
  if (indices.length === 0) return null;

  return (
    <div className="video-filmstrip">
      {indices.map(i => {
        const secs = tileStartSecs(board, i);
        return (
          <div
            key={i}
            className={`video-filmstrip-frame${onFrameClick ? " clickable" : ""}`}
            onClick={onFrameClick ? () => onFrameClick(secs) : undefined}
          >
            <StoryboardTile board={board} index={i} className="video-filmstrip-tile" />
            {onFrameClick && (
              <svg className="video-filmstrip-play" width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/>
              </svg>
            )}
            <span className="video-filmstrip-ts">{formatTimestamp(secs)}</span>
          </div>
        );
      })}
    </div>
  );
}
