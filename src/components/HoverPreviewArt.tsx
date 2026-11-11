import type { ReactNode } from "react";
import { StoryboardTile } from "./StoryboardTile";
import { useHoverStoryboard, type HoverPreviewSource } from "../hooks/useHoverStoryboard";
import type { StoryboardTrack } from "../hooks/useStoryboard";
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
 * while hovered — a flip-book of storyboard tiles over it. See `useHoverStoryboard`.
 */
export function HoverPreviewArt({ track, source, className, art, children, onClick }: HoverPreviewArtProps) {
  const { hoverProps, board, tile, loading } = useHoverStoryboard(track, source);
  return (
    <div className={className} onClick={onClick} {...hoverProps}>
      {art}
      {board && tile !== null && (
        <StoryboardTile board={board} index={tile} className="hover-preview-tile" cover />
      )}
      {loading && (
        <div className="hover-preview-loading" role="status" aria-label="Loading preview">
          <span className="hover-preview-loading-fill ds-motion-essential" />
        </div>
      )}
      {children}
    </div>
  );
}
