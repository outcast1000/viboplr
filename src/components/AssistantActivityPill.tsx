import { useEffect, useState } from "react";
import {
  panelEntries,
  pillView,
  relativeTime,
  type ActivityEntry,
  type PillView,
} from "../utils/assistantActivity";
import type { AssistantActivityState } from "../hooks/useAssistantActivity";
import "./AssistantActivityPill.css";

interface Props {
  activity: AssistantActivityState;
  /** The control API is on. Without it nothing can happen, and a standing
   *  "paused" pill would be about a switch that does nothing. */
  enabled: boolean;
  /** Showcase and mini mode: nothing may sit over the window. */
  hidden: boolean;
  /** Opens Settings → AI control at the full log. */
  onOpenLog: () => void;
}

function tone(view: PillView): string {
  switch (view.mode) {
    case "paused":
    case "failed":
      return "bad";
    case "running":
    case "done":
      return view.outward ? "outward" : view.mode;
    default:
      return "idle";
  }
}

/** "Liked track “So What”" already says what the label says, so the detail
 *  leads when there is one and the label alone otherwise. */
function withDetail(label: string, detail?: string): string {
  return detail ? `${label}: ${detail}` : label;
}

function pillText(view: PillView): string {
  switch (view.mode) {
    case "paused":
      return view.refused > 0 ? `Assistant paused · ${view.refused} refused` : "Assistant paused";
    case "running":
      return `Assistant · ${withDetail(view.label, view.detail)}${view.extra > 0 ? ` +${view.extra} more` : ""}`;
    case "done":
      return `Assistant · ${withDetail(view.label, view.detail)}`;
    case "failed":
      return view.count > 1
        ? `Assistant · ${view.count} calls failed`
        : `Assistant · ${withDetail(view.label, view.detail)} failed`;
    default:
      return "Assistant activity";
  }
}

function rowDot(entry: ActivityEntry): string {
  if (entry.status === "failed" || entry.status === "paused") return "bad";
  if (entry.status === "running") return "running";
  return entry.kind === "outward" ? "outward" : "ok";
}

/**
 * The assistant's presence in the app: a small pill that appears while the
 * assistant is changing something, a list of what it just did, and the Pause
 * switch. Reads and page navigation never light it (they are in the log).
 *
 * Fixed over the content like a toast, not placed in the grid — it must not
 * take layout, and it must not be there when nothing is happening.
 */
export function AssistantActivityPill({ activity, enabled, hidden, onOpenLog }: Props) {
  const { entries, paused, setPaused, dismissedBefore, dismissFailures } = activity;
  const [open, setOpen] = useState(false);
  // `now` ticks once a second, but only while something time-based is on
  // screen (the linger after a call, the "12s ago" labels). When the pill goes
  // idle the clock stops; the next call's entry finishes "in the future" of the
  // stale value, which reads as just-now, and the first tick catches it up.
  const [now, setNow] = useState(() => Date.now());
  const view = pillView(entries, paused && enabled, now, dismissedBefore);
  const ticking = view.mode !== "hidden" || open;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (hidden || !enabled) return null;
  if (view.mode === "hidden" && !open) return null;

  const rows = panelEntries(entries, now, dismissedBefore);
  const hasFailures = rows.some((e) => e.status === "failed" || e.status === "paused");

  return (
    <div className="aa-wrap">
      {open && (
        <div className="aa-panel" role="dialog" aria-label="Assistant activity">
          <div className="aa-panel-head">
            <span>Assistant activity</span>
            <button type="button" className="aa-link" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          {rows.length === 0 ? (
            <div className="aa-empty">Nothing changed in the last few minutes.</div>
          ) : (
            <ul className="aa-list">
              {rows.map((e) => (
                <li key={e.id} className="aa-row">
                  <span className={`aa-dot aa-dot--${rowDot(e)}`} aria-hidden="true" />
                  <span className="aa-row-main">
                    <span className="aa-row-label">{e.label}</span>
                    {e.detail && <span className="aa-row-detail">{e.detail}</span>}
                    {e.result && e.status === "ok" && <span className="aa-row-result">{e.result}</span>}
                    {(e.status === "failed" || e.status === "paused") && e.error && (
                      <span className="aa-row-error">{e.error}</span>
                    )}
                    {e.kind === "outward" && e.status !== "paused" && (
                      <span className="aa-row-note">May leave this machine</span>
                    )}
                  </span>
                  <span className="aa-row-time">
                    {e.status === "running" ? "running" : relativeTime(e.startedMs, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="aa-panel-foot">
            <button
              type="button"
              className="aa-link"
              onClick={() => {
                setOpen(false);
                onOpenLog();
              }}
            >
              Open full log
            </button>
            <span className="aa-foot-actions">
              {hasFailures && (
                <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" onClick={dismissFailures}>
                  Dismiss failures
                </button>
              )}
              <button
                type="button"
                className={`ds-btn ds-btn--sm ${paused ? "ds-btn--primary" : "ds-btn--secondary"}`}
                onClick={() => void setPaused(!paused)}
              >
                {paused ? "Resume assistant" : "Pause assistant"}
              </button>
            </span>
          </div>
        </div>
      )}
      <div className={`aa-pill aa-pill--${tone(view)}`} role="status" aria-live="polite">
        <button
          type="button"
          className="aa-pill-main"
          aria-expanded={open}
          title="Show what the assistant did"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="aa-dot aa-dot--pill" aria-hidden="true" />
          <span className="aa-pill-text">{pillText(view)}</span>
        </button>
        {view.mode === "running" && (
          <button type="button" className="aa-pill-btn" onClick={() => void setPaused(true)}>
            Pause
          </button>
        )}
        {view.mode === "paused" && (
          <button type="button" className="aa-pill-btn aa-pill-btn--go" onClick={() => void setPaused(false)}>
            Resume
          </button>
        )}
        {view.mode === "failed" && (
          <button type="button" className="aa-pill-btn" onClick={dismissFailures}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
