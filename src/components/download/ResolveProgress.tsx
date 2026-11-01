import { useEffect, useState } from "react";
import type { DownloadResolveProgress } from "../../types/plugin";

/** mm:ss for a live counter. Unlike `formatDuration`, zero is a real value here
 *  (a resolve that just started, an ETA of "any moment") rather than missing
 *  data, so it must not render as "--:--". */
function formatElapsed(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * What the provider says it is doing while it resolves. A provider that mints a
 * URL reports nothing and is over in a moment; one that downloads the file
 * itself (yt-dlp fetching a video and merging it with ffmpeg) can run for
 * minutes, and this is all that stands between the user and an unexplained
 * spinner. Mounted only while a resolve runs, so its elapsed counter starts at
 * zero each time.
 */
export function ResolveProgress({ progress }: { progress: DownloadResolveProgress | null }) {
  // Always shown: elapsed is the one fact available for every provider, and
  // it's what separates "slow but moving" from "stuck".
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const detail = [
    progress?.detail,
    progress?.etaSecs != null ? `${formatElapsed(progress.etaSecs)} left` : null,
    `${formatElapsed(elapsed)} elapsed`,
  ].filter(Boolean).join(" · ");

  return (
    <div className="dl-resolving">
      {typeof progress?.percent === "number" ? (
        <div className="dl-progress">
          <div className="dl-progress-bar">
            <div className="dl-progress-fill" style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
          </div>
          <span className="dl-progress-pct">{Math.round(progress.percent)}%</span>
        </div>
      ) : (
        <div className="ds-spinner ds-spinner--sm" />
      )}
      <span className="dl-resolving-label">{progress?.label || "Preparing download…"}</span>
      <span className="dl-resolving-detail">{detail}</span>
    </div>
  );
}
