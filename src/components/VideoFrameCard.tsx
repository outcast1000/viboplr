import { useState, useRef, useCallback, useEffect } from "react";
import { FilmReel } from "./FilmReel";
import "./VideoFrameCard.css";

interface VideoFrameCardProps {
  frames: string[];
  alt: string;
  className?: string;
  timestamps?: number[] | null;
  onFrameClick?: (timestampSecs: number) => void;
}

export function VideoFrameCard({ frames, alt, className, timestamps, onFrameClick }: VideoFrameCardProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [hovering, setHovering] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const handleMouseEnter = useCallback(() => {
    setHovering(true);
    if (intervalRef.current) clearInterval(intervalRef.current);
    let idx = 0;
    intervalRef.current = setInterval(() => {
      idx = (idx + 1) % frames.length;
      setActiveIndex(idx);
    }, 1200);
  }, [frames.length]);

  const handleMouseLeave = useCallback(() => {
    setHovering(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setActiveIndex(0);
  }, []);

  const handleDotClick = useCallback((e: React.MouseEvent, i: number) => {
    e.stopPropagation();
    setActiveIndex(i);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (onFrameClick && timestamps?.[i] != null) onFrameClick(timestamps[i]);
  }, [onFrameClick, timestamps]);

  const handleImageClick = useCallback(() => {
    if (onFrameClick && timestamps?.[activeIndex] != null) onFrameClick(timestamps[activeIndex]);
  }, [onFrameClick, timestamps, activeIndex]);

  return (
    <div
      className={`video-frame-card ${className ?? ""}${onFrameClick ? " clickable" : ""}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={onFrameClick ? handleImageClick : undefined}
    >
      {frames.map((src, i) => (
        <img
          key={i}
          className={`video-frame-card-img${i === activeIndex ? " active" : ""}`}
          src={src}
          alt={`${alt} frame ${i + 1}`}
          draggable={false}
        />
      ))}
      {frames.length > 0 && (
        <div className="video-frame-card-badge" title="Video">
          <FilmReel size={12} />
        </div>
      )}
      {hovering && frames.length > 1 && (
        <div className="video-frame-card-dots">
          {frames.map((_, i) => (
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
