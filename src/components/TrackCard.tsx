// Presentational tile/grid card for a track (the `.album-card` layout). Sibling
// to TrackRow: a card is not a row, so it keeps overlay-in-art play/like/⋯
// controls rather than the row hover-action tray, but selection/play/like are
// driven by the same parent handlers (same shared computeSelection upstream).
// State (selected) and all interaction live in the parent; this is pure markup.
import type { ReactNode } from "react";
import type { Album } from "../types";
import { AlbumCardArt } from "./AlbumCardArt";
import { VideoRowThumb } from "./VideoRowThumb";
import { LikeDislikeButtons } from "./LikeDislikeButtons";

// Art is resolved by the caller into one of three shapes (mirrors TrackRowThumb).
export type TrackCardArt =
  | { kind: "video"; trackId: number; alt: string }
  | { kind: "album"; album: Album; imagePath: string | null }
  | { kind: "letter"; text: string };

export interface TrackCardProps {
  art: TrackCardArt;
  title: string;
  subtitle?: ReactNode;         // e.g. "Artist · 3:21"
  liked: number;
  playing?: boolean;
  selected?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onMouseDown?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onPlay: () => void;
  onLocate: () => void;         // art-wrapper click → navigate to detail
  onToggleLike: () => void;
  onToggleDislike?: () => void;
}

function CardArt({ art }: { art: TrackCardArt }) {
  if (art.kind === "video") {
    return <VideoRowThumb trackId={art.trackId} alt={art.alt} className="album-card-art" />;
  }
  if (art.kind === "album") {
    return <AlbumCardArt album={art.album} imagePath={art.imagePath} />;
  }
  return <div className="album-card-art">{art.text}</div>;
}

export function TrackCard({
  art, title, subtitle, liked, playing, selected,
  onClick, onMouseDown, onDoubleClick, onContextMenu,
  onPlay, onLocate, onToggleLike, onToggleDislike,
}: TrackCardProps) {
  return (
    <div
      className={`album-card${playing ? " playing" : ""}${selected ? " selected" : ""}`}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className="album-card-art-wrapper" onClick={(e) => { e.stopPropagation(); onLocate(); }}>
        <CardArt art={art} />
        <LikeDislikeButtons
          liked={liked}
          onToggleLike={onToggleLike}
          onToggleDislike={onToggleDislike}
          variant="overlay"
          size={12}
        />
        <button className="album-card-menu-btn" onClick={(e) => { e.stopPropagation(); onContextMenu?.(e); }} title="More options">&#x22EF;</button>
        <button className="ds-card-play" onClick={(e) => { e.stopPropagation(); onPlay(); }} title="Play">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
        </button>
      </div>
      <div className="album-card-body">
        <div className="album-card-title" title={title}>{title}</div>
        {subtitle != null && <div className="album-card-info">{subtitle}</div>}
      </div>
    </div>
  );
}
