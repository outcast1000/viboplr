import { useState, useRef, useCallback, useEffect } from "react";
import { FilmReel } from "./FilmReel";
import { StoryboardTile } from "./StoryboardTile";
import { spreadTileIndices, tileStartSecs, type Storyboard } from "../utils/storyboard";
import "./VideoFrameCard.css";

/** Moments offered while cycling. Matches the dot count the card can show legibly —
 *  the storyboard holds far more, but a strip of 22 dots is not a control. */
const CYCLE_TILES = 4;
const CYCLE_INTERVAL_MS = 1200;
/** The hero art slot is a fixed 220x220 square (`.detail-hero-art`). Tiles are 16:9,
 *  so they must be cover-cropped to fill it — and cover-cropping can't be expressed
 *  in percentages, so the size has to be stated rather than left to CSS. */
const ART_SIZE = 220;

interface VideoFrameCardProps {
  /** The track's single large frame — the sharp resting image. */
  poster: string | null;
  /** Storyboard backing the hover cycle. Without one the card is just the poster. */
  board: Storyboard | null;
  alt: string;
  className?: string;
  onFrameClick?: (timestampSecs: number) => void;
}

/**
 * Video hero art: a still frame that cycles through moments on hover.
 *
 * The resting image is the track's own extracted frame, kept at full resolution
 * because this is a large surface. Cycling reads tiles from the storyboard instead —
 * lower resolution, but only ever seen in motion, and it avoids extracting a second
 * set of large frames purely for an animation (see docs/seek-preview-spec.md).
 */
export function VideoFrameCard({ poster, board, alt, className, onFrameClick }: VideoFrameCardProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [hovering, setHovering] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tiles to cycle through, evenly spread across the video.
  const tiles = board ? spreadTileIndices(board, CYCLE_TILES) : [];
  const canCycle = board !== null && tiles.length > 1;

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // A track change can leave the index past the end of a shorter tile list.
  useEffect(() => {
    setActiveIndex(0);
  }, [board]);

  const handleMouseEnter = useCallback(() => {
    setHovering(true);
    if (!canCycle) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setActiveIndex(i => (i + 1) % tiles.length);
    }, CYCLE_INTERVAL_MS);
  }, [canCycle, tiles.length]);

  const handleMouseLeave = useCallback(() => {
    setHovering(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setActiveIndex(0);
  }, []);

  const seekTo = useCallback((tileIdx: number) => {
    if (!onFrameClick || !board) return;
    onFrameClick(tileStartSecs(board, tileIdx));
  }, [onFrameClick, board]);

  const handleDotClick = useCallback((e: React.MouseEvent, i: number) => {
    e.stopPropagation();
    setActiveIndex(i);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    seekTo(tiles[i]);
  }, [seekTo, tiles]);

  const handleImageClick = useCallback(() => {
    // Index 0 is the poster, which depicts the frame the producer sampled first.
    if (board && tiles[activeIndex] != null) seekTo(tiles[activeIndex]);
  }, [board, tiles, activeIndex, seekTo]);

  if (!poster && !board) return null;

  return (
    <div
      className={`video-frame-card ${className ?? ""}${onFrameClick ? " clickable" : ""}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={onFrameClick ? handleImageClick : undefined}
    >
      {poster && (
        <img
          className={`video-frame-card-img${activeIndex === 0 ? " active" : ""}`}
          src={poster}
          alt={alt}
          draggable={false}
        />
      )}
      {board && tiles.map((tileIdx, i) => (
        // Skip slot 0 when a poster covers it — the poster is the sharper image.
        (i === 0 && poster) ? null : (
          <StoryboardTile
            key={tileIdx}
            board={board}
            index={tileIdx}
            className={`video-frame-card-img${i === activeIndex ? " active" : ""}`}
            width={ART_SIZE}
            height={ART_SIZE}
            cover
          />
        )
      ))}
      <div className="video-frame-card-badge" title="Video">
        <FilmReel size={12} />
      </div>
      {hovering && canCycle && (
        <div className="video-frame-card-dots">
          {tiles.map((_, i) => (
            <span
              key={i}
              className={`video-frame-card-dot${i === activeIndex ? " active" : ""}`}
              onClick={(e) => handleDotClick(e, i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
