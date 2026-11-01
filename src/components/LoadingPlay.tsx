import { useEffect, useState } from "react";
import type { LoadingPlay } from "../hooks/useQueue";
import { resolveImageUrl } from "../utils/resolveImageUrl";

// What the queue panel and the bars show while a play is still being built
// (useQueue → LoadingPlay; conventions.md "Play With Backfill").

/** How many placeholder rows stand in for the songs on their way. */
export const LOADING_PLACEHOLDER_ROWS = 10;

/** "8s", "1:05". */
export function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/** Seconds since `since`, ticking once a second while it is mounted — a source
 *  can take 25s, and the one fact every source has is how long it's been. */
export function LoadingElapsed({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className={className}>{formatElapsed(now - since)}</span>;
}

/** "from Spotify", or nothing when the source isn't known. */
function fromSource(play: LoadingPlay): string {
  return play.source ? ` from ${play.source}` : "";
}

/** A switch is pending: the queue below keeps playing until the new list lands. */
export function QueueSwitchBanner({ play, onCancel }: { play: LoadingPlay; onCancel: () => void }) {
  const cover = play.imagePath ? resolveImageUrl(play.imagePath) : null;
  return (
    <div className="queue-switch-banner" role="status">
      <div className="queue-switch-cover">
        {cover ? <img src={cover} alt="" onError={e => { e.currentTarget.style.display = "none"; }} /> : null}
      </div>
      <div className="queue-switch-text">
        <div className="queue-switch-name">
          <span className="queue-item-resolving-icon ds-motion-essential" />
          <span>Starting {play.name}</span>
        </div>
        <div className="queue-switch-meta">
          Replaces this queue when it's ready{fromSource(play) ? ` · loading${fromSource(play)}` : ""} · <LoadingElapsed since={play.startedAt} />
        </div>
      </div>
      <button className="queue-switch-cancel" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/** The rest of an extend is on its way: a label and placeholder rows after the
 *  queue. `waiting` = the queue ran out and its first song plays next. */
export function QueueLoadingBlock({ play, waiting }: { play: LoadingPlay; waiting: boolean }) {
  return (
    <div className="queue-loading-block">
      <div className="queue-loading-label" role="status">
        <span className="queue-item-resolving-icon ds-motion-essential" />
        <span className="queue-loading-label-text">
          {waiting ? <><strong>Up next</strong> · loading{fromSource(play)}</> : `Loading the rest${fromSource(play)}`}
        </span>
        <LoadingElapsed since={play.startedAt} className="queue-loading-elapsed" />
      </div>
      {Array.from({ length: LOADING_PLACEHOLDER_ROWS }, (_, i) => (
        <div
          key={i}
          className={`queue-placeholder-row${i === 0 && waiting ? " queue-placeholder-row--next" : ""}`}
          style={{ "--placeholder-delay": `${i * 90}ms` } as React.CSSProperties}
          aria-hidden="true"
        >
          <span className="queue-placeholder-art" />
          <span className="queue-placeholder-lines">
            <span className="queue-placeholder-bar" style={{ width: `${56 + ((i * 37) % 28)}%` }} />
            <span className="queue-placeholder-bar" style={{ width: `${34 + ((i * 23) % 20)}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The rest never arrived; the head kept playing. */
export function QueueLoadFailureRow({ message }: { message: string }) {
  return (
    <div className="queue-load-failure" role="status">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /><path d="M8 4.5v4M8 11v.5" /></svg>
      <span>{message}</span>
    </div>
  );
}
