import { useState, useRef, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";

interface StatusBarProps {
  sessionLog: { time: Date; message: string }[];
}

export function StatusBar({ sessionLog }: StatusBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeMessage, setActiveMessage] = useState<{ message: string; time: Date; isError: boolean } | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    getVersion().then(setAppVersion);
  }, []);

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

  return (
    <div className="status-bar" ref={panelRef}>
      <div className="status-bar-content" onClick={() => setExpanded(!expanded)}>
        {activeMessage ? (
          <>
            <span className={`status-bar-icon ${activeMessage.isError ? "status-bar-icon-error" : ""}`}>
              {activeMessage.isError ? "\u26A0" : "\u2139"}
            </span>
            <span className="status-bar-text">{activeMessage.message}</span>
            <span className="status-bar-time">{activeMessage.time.toLocaleTimeString()}</span>
          </>
        ) : (
          <span className="status-bar-text status-bar-version">FastPlayer {appVersion}</span>
        )}
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
