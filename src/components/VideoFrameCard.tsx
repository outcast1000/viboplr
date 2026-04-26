import { useState, useRef, useCallback, useEffect } from "react";
import "./VideoFrameCard.css";

interface VideoFrameCardProps {
  frames: string[];
  alt: string;
  className?: string;
}

export function VideoFrameCard({ frames, alt, className }: VideoFrameCardProps) {
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

  return (
    <div
      className={`video-frame-card ${className ?? ""}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {frames.map((src, i) => (
        <img
          key={i}
          className={`video-frame-card-img${i === activeIndex ? " active" : ""}`}
          src={src}
          alt={`${alt} frame ${i + 1}`}
        />
      ))}
      {frames.length > 0 && (
        <div className="video-frame-card-badge" title="Video">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/>
          </svg>
        </div>
      )}
      {hovering && frames.length > 1 && (
        <div className="video-frame-card-dots">
          {frames.map((_, i) => (
            <span key={i} className={`video-frame-card-dot${i === activeIndex ? " active" : ""}`} />
          ))}
        </div>
      )}
    </div>
  );
}
