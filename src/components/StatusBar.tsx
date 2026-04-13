import { useState, useRef, useEffect } from "react";
import "./StatusBar.css";

interface StatusBarProps {
  sessionLog: { time: Date; message: string }[];
  activity?: string | null;
  downloadStatus?: {
    active: { id: number; track_title: string; artist_name: string; progress_pct: number } | null;
    queued: { id: number; track_title: string; artist_name: string }[];
    completed: { id: number; track_title: string; status: string; error?: string }[];
  } | null;
  onCancelDownload?: (id: number) => void;
}

export function StatusBar({ sessionLog, activity, downloadStatus, onCancelDownload }: StatusBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeMessage, setActiveMessage] = useState<{ message: string; time: Date; isError: boolean } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (sessionLog.length === 0) return;
    const latest = sessionLog[sessionLog.length - 1];
    const isError = latest.message.toLowerCase().includes("error") || latest.message.toLowerCase().includes("failed");
    setActiveMessage({ message: latest.message, time: latest.time, isError });
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setActiveMessage(null), 5000);
    return () => clearTimeout(timerRef.current);
  }, [sessionLog.length]);

  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [expanded]);

  const [showDownloads, setShowDownloads] = useState(false);
  const hasDownloads = downloadStatus && (downloadStatus.active || downloadStatus.queued.length > 0 || downloadStatus.completed.length > 0);

  const visible = activeMessage !== null || expanded || !!activity || !!hasDownloads;

  return (
    <div className={`status-bar ${visible ? "status-bar-visible" : ""}`} ref={panelRef}>
      {hasDownloads && (
        <div className="status-bar-downloads">
          <button
            className="status-bar-download-btn"
            onClick={(e) => { e.stopPropagation(); setShowDownloads(!showDownloads); }}
          >
            {"\u2B07"}{" "}
            {downloadStatus.active ? `${downloadStatus.active.progress_pct}%` : ""}
            {downloadStatus.queued.length > 0 && ` +${downloadStatus.queued.length}`}
          </button>
          {showDownloads && (
            <div className="status-bar-download-popover">
              {downloadStatus.active && (
                <div className="download-item download-item-active">
                  <div className="download-item-info">
                    <span className="download-item-title">{downloadStatus.active.track_title}</span>
                    <span className="download-item-artist">{downloadStatus.active.artist_name}</span>
                  </div>
                  <div className="download-progress-bar">
                    <div className="download-progress-fill" style={{ width: `${downloadStatus.active.progress_pct}%` }} />
                  </div>
                </div>
              )}
              {downloadStatus.queued.map(q => (
                <div key={q.id} className="download-item">
                  <div className="download-item-info">
                    <span className="download-item-title">{q.track_title}</span>
                    <span className="download-item-artist">{q.artist_name}</span>
                  </div>
                  {onCancelDownload && (
                    <button className="download-cancel-btn" onClick={() => onCancelDownload(q.id)}>X</button>
                  )}
                </div>
              ))}
              {downloadStatus.completed.slice(-5).map(c => (
                <div key={c.id} className={`download-item download-item-${c.status}`}>
                  <span className="download-item-title">{c.track_title}</span>
                  <span className="download-item-status">{c.status === "complete" ? "\u2713" : "\u2717"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="status-bar-content" onClick={() => setExpanded(!expanded)}>
        {activity ? (
          <>
            <span className="status-bar-icon status-bar-icon-spin">{"\u27F3"}</span>
            <span className="status-bar-text">{activity}</span>
          </>
        ) : activeMessage ? (
          <>
            <span className={`status-bar-icon ${activeMessage.isError ? "status-bar-icon-error" : ""}`}>
              {activeMessage.isError ? "\u26A0" : "\u2139"}
            </span>
            <span className="status-bar-text">{activeMessage.message}</span>
            <span className="status-bar-time">{activeMessage.time.toLocaleTimeString()}</span>
          </>
        ) : null}
      </div>
      {expanded && (
        <div className="status-bar-log">
          <div className="status-bar-log-header">
            <span>Log</span>
          </div>
          <div className="status-bar-log-list">
            {sessionLog.length === 0 && <div className="log-empty">No events yet</div>}
            {[...sessionLog].reverse().map((entry, i) => (
              <div key={i} className="log-entry">
                <span className="log-time">{entry.time.toLocaleTimeString()}</span>
                <span>{entry.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
