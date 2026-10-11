import { useState } from "react";
import {
  KIND_LABELS,
  LOG_FILTERS,
  filterLog,
  type ActivityEntry,
  type LogFilter,
} from "../utils/assistantActivity";
import type { AssistantActivityState } from "../hooks/useAssistantActivity";
import { ToggleSwitch } from "./ToggleSwitch";
import "./AssistantActivityLog.css";

function resultText(entry: ActivityEntry): string {
  switch (entry.status) {
    case "running":
      return "Running";
    case "failed":
      return "Failed";
    case "paused":
      return "Refused (paused)";
    default:
      return "Done";
  }
}

/**
 * Settings → AI control → Assistant activity: the pause switch and the log of
 * what connected assistants asked Vibo to do since it started. Memory-only
 * (the durable trace is the `Assistant change [verb]` lines in the app log),
 * capped at 200 calls, and — unlike the pill — it includes reads and page
 * navigation, so "what did it look at" has an answer too.
 */
export function AssistantActivityLog({ activity }: { activity: AssistantActivityState }) {
  const { entries, paused, setPaused, clear } = activity;
  const [filter, setFilter] = useState<LogFilter>("all");
  const rows = filterLog(entries, filter);

  return (
    <div className="settings-group" id="assistant-activity">
      <div className="settings-group-title">Assistant activity</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-label">Pause the assistant</span>
            <span className="settings-description">
              {paused
                ? "Paused. Every change and every plugin call is refused until you resume. Reads and page navigation still work."
                : "Refuses every change and every plugin call until you resume. Reads and page navigation still work. Stays paused after a restart."}
            </span>
          </div>
          <div className="settings-row-actions">
            <ToggleSwitch checked={paused} onChange={(v) => void setPaused(v)} label="Pause the assistant" />
          </div>
        </div>
        <div className="aal-body">
          <div className="aal-toolbar">
            <div className="aal-filters" role="group" aria-label="Filter the activity log">
              {LOG_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`aal-chip${filter === f.id ? " is-on" : ""}`}
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="ds-btn ds-btn--secondary ds-btn--sm"
              disabled={entries.length === 0}
              onClick={clear}
            >
              Clear
            </button>
          </div>
          {rows.length === 0 ? (
            <div className="aal-empty">
              {entries.length === 0
                ? "Nothing yet. Calls from connected assistants appear here while Vibo is open."
                : "No calls match this filter."}
            </div>
          ) : (
            <div className="aal-scroll">
              <table className="aal-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id}>
                      <td className="aal-time">{new Date(e.startedMs).toLocaleTimeString()}</td>
                      <td>
                        <div className="aal-label">{e.label}</div>
                        {e.detail && <div className="aal-detail">{e.detail}</div>}
                        <div className="aal-meta">
                          <span className={`aal-tag aal-tag--${e.kind}`}>{KIND_LABELS[e.kind]}</span>
                          <code>
                            {e.method} {e.route.replace(/^\/v1/, "")}
                          </code>
                        </div>
                      </td>
                      <td>
                        <span className={`aal-result aal-result--${e.status}`}>{resultText(e)}</span>
                        {e.result && <div className="aal-resulttext">{e.result}</div>}
                        {e.error && <div className="aal-error">{e.error}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="aal-note">The last 200 calls, kept until you quit Vibo.</div>
        </div>
      </div>
    </div>
  );
}
