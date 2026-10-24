import { useEffect, useState } from "react";
import { pillView, type PillView } from "../utils/assistantActivity";
import type { AssistantActivityState } from "../hooks/useAssistantActivity";
import "./AssistantActivityPill.css";

interface Props {
  activity: AssistantActivityState;
  /** The control API is on. Without it nothing can happen, and a standing
   *  "paused" segment would be about a switch that does nothing. */
  enabled: boolean;
  /** Showcase and mini mode: nothing may sit over the window. */
  hidden: boolean;
  /** Opens Settings → AI control at the activity log. */
  onOpenLog: () => void;
}

function text(view: PillView): string {
  switch (view.mode) {
    case "paused":
      return view.refused > 0 ? `Assistant paused · ${view.refused} refused` : "Assistant paused";
    case "working":
      return view.count > 0 ? `Assistant working · ${view.count}` : "Assistant working";
    case "done":
      return `Assistant · ${view.count} change${view.count === 1 ? "" : "s"}`;
    case "failed":
      return view.count > 1 ? `Assistant · ${view.count} calls failed` : "Assistant · a call failed";
    default:
      return "";
  }
}

function tone(view: PillView): string {
  switch (view.mode) {
    case "paused":
      return "warning";
    case "failed":
      return "error";
    case "working":
    case "done":
      return view.outward ? "warning" : view.mode === "working" ? "info" : "success";
    default:
      return "info";
  }
}

const RING = 2 * Math.PI * 6;

/**
 * The assistant's segment in the bottom-right corner. It exists only while the
 * assistant is changing something, for `PILL_LINGER_MS` after, while paused,
 * and until a failure has been looked at — never at rest, and never at all
 * with AI control off. It reports a **session** ("Assistant working · 3"), so
 * a burst of calls moves a count instead of swapping labels.
 *
 * Two controls: **Pause** (the rightmost button in the corner — the toast
 * opens to its left, so nothing can push it) and the label, which opens
 * Settings → AI control with the full log. It has no popover of its own; the
 * assistant isn't mixed into the notifications list either.
 */
export function AssistantActivityPill({ activity, enabled, hidden, onOpenLog }: Props) {
  const { entries, paused, setPaused, dismissedBefore } = activity;
  // `now` ticks only while the segment is up (the hold, the linger ring). When
  // it went idle the clock stopped; a new call then reads as "in the future" of
  // the stale value — i.e. just now, working — and the first tick catches up.
  const [now, setNow] = useState(() => Date.now());
  const view = pillView(entries, paused && enabled, now, dismissedBefore);
  const ticking = enabled && !hidden && view.mode !== "hidden";
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  if (hidden || !enabled || view.mode === "hidden") return null;
  const pauseLabel = paused ? "Resume assistant" : "Pause assistant";

  return (
    // The Pause/Resume button is the user's; the generic input refuses it.
    <div data-ui-input-protected="" className={`aa-pill notice-tone--${tone(view)}${view.mode === "working" ? " aa-pill--working" : ""}`} role="status" aria-live="polite">
      <button type="button" className="aa-pill-main" title="Open Settings → AI control" onClick={onOpenLog}>
        <svg className="aa-pill-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
          <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
        </svg>
        <span className="aa-pill-text">{text(view)}</span>
        {view.mode === "done" && (
          <svg className="aa-pill-linger" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" />
            <circle className="aa-pill-linger-arc" cx="8" cy="8" r="6" strokeDasharray={RING} strokeDashoffset={RING * (1 - view.left)} />
          </svg>
        )}
      </button>
      <button
        type="button"
        className={`aa-pill-pause${paused ? " is-paused" : ""}`}
        title={pauseLabel}
        aria-label={pauseLabel}
        onClick={() => void setPaused(!paused)}
      >
        {paused ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
        )}
      </button>
    </div>
  );
}
