import type { VideoFramesState } from "../hooks/useVideoFrames";
import "./VideoFilmstrip.css";

function formatTimestamp(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface VideoFilmstripProps {
  framesState: VideoFramesState;
}

export function VideoFilmstrip({ framesState }: VideoFilmstripProps) {
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
        <div key={i} className="video-filmstrip-frame">
          <img src={src} alt={`Frame ${i + 1}`} />
          {timestamps && timestamps[i] != null && (
            <span className="video-filmstrip-ts">{formatTimestamp(timestamps[i])}</span>
          )}
        </div>
      ))}
    </div>
  );
}
