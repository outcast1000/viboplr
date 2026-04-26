import type { VideoFramesState } from "../hooks/useVideoFrames";
import "./VideoFilmstrip.css";

function formatTimestamp(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface VideoFilmstripProps {
  framesState: VideoFramesState;
  onFrameClick?: (timestampSecs: number) => void;
}

export function VideoFilmstrip({ framesState, onFrameClick }: VideoFilmstripProps) {
  const { frames, timestamps, loading, unavailable } = framesState;

  if (unavailable) {
    return (
      <div className="video-filmstrip-hint">
        Install ffmpeg for video frame previews
      </div>
    );
  }

  if (loading) {
    return (
      <div className="video-filmstrip">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="video-filmstrip-placeholder" />
        ))}
      </div>
    );
  }

  if (!frames || frames.length === 0) return null;

  return (
    <div className="video-filmstrip">
      {frames.map((src, i) => (
        <div
          key={i}
          className={`video-filmstrip-frame${onFrameClick ? " clickable" : ""}`}
          onClick={onFrameClick && timestamps?.[i] != null ? () => onFrameClick(timestamps[i]) : undefined}
        >
          <img src={src} alt={`Frame ${i + 1}`} draggable={false} />
          {onFrameClick && (
            <svg className="video-filmstrip-play" width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/>
            </svg>
          )}
          {timestamps && timestamps[i] != null && (
            <span className="video-filmstrip-ts">{formatTimestamp(timestamps[i])}</span>
          )}
        </div>
      ))}
    </div>
  );
}
