import type { ReactNode } from "react";
import { StoryboardTile } from "./StoryboardTile";
import { useHoverStoryboard, type HoverPreviewSource } from "../hooks/useHoverStoryboard";
import type { StoryboardTrack } from "../hooks/useStoryboard";
import { formatDuration } from "../utils";
import "./HoverPreviewArt.css";

interface HoverPreviewArtProps {
  /** The card's video, or null for anything else — then this is a plain box. */
  track: StoryboardTrack | null;
  source: HoverPreviewSource;
  className: string;
  /** The resting art (cover, frame or placeholder). */
  art: ReactNode;
  /** Drawn above the preview: play button, loading veil… */
  children?: ReactNode;
  onClick?: () => void;
}

/**
 * Art box for a Home card or the hero carousel: resting art, and — for a video,
 * while hovered — a flip-book of storyboard tiles over it, with the moment each
 * tile shows ("12:34 / 45:10") and a bar for how far into the video that is.
 * See `useHoverStoryboard`.
 */
export function HoverPreviewArt({ track, source, className, art, children, onClick }: HoverPreviewArtProps) {
  const { hoverProps, board, tile, position, loading, generating } = useHoverStoryboard(track, source);
  // The chip: the frame's moment, plus — while the sheet is still being made —
  // how many frames are ready, so a slow pass reads as progress, not a hang.
  const ready = generating ? `${generating.done}/${generating.count}` : null;
  const chip = position
    ? `${formatDuration(position.secs)} / ${formatDuration(position.totalSecs)}${ready ? ` · ${ready}` : ""}`
    : ready ? `Preparing ${ready}` : loading ? "Preparing…" : null;
  return (
    <div className={className} onClick={onClick} {...hoverProps}>
      {art}
      {board && tile !== null && (
        <StoryboardTile board={board} index={tile} className="hover-preview-tile" cover />
      )}
      {chip && <span className="hover-preview-time">{chip}</span>}
      {/* One bar along the bottom: how far the pass has got while it runs (a
          sweep when there's no count to show), then where the frame sits. */}
      {loading ? (
        <div className="hover-preview-progress" role="status" aria-label="Preparing preview">
          {generating ? (
            <span
              className="hover-preview-progress-fill hover-preview-progress-fill--making"
              style={{ transform: `scaleX(${generating.done / generating.count})` }}
            />
          ) : (
            <span className="hover-preview-loading-fill ds-motion-essential" />
          )}
        </div>
      ) : position && (
        <div className="hover-preview-progress" aria-hidden="true">
          <span
            className="hover-preview-progress-fill"
            style={{ transform: `scaleX(${position.fraction})` }}
          />
        </div>
      )}
      {children}
    </div>
  );
}
