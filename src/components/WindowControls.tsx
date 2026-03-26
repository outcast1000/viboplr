import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const isMac = navigator.platform.includes("Mac");

interface WindowControlsProps {
  position: "left" | "right";
}

export function WindowControls({ position }: WindowControlsProps) {
  const shouldRender = (isMac && position === "left") || (!isMac && position === "right");

  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const cleanupRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    if (!shouldRender) return;
    let cancelled = false;
    const win = getCurrentWindow();
    win.isMaximized().then(v => { if (!cancelled) setMaximized(v); }).catch(() => {});
    win.isFocused().then(v => { if (!cancelled) setFocused(v); }).catch(() => {});

    win.onResized(() => {
      if (!cancelled) win.isMaximized().then(v => { if (!cancelled) setMaximized(v); }).catch(() => {});
    }).then(unlisten => {
      if (cancelled) unlisten();
      else cleanupRef.current.push(unlisten);
    });

    win.onFocusChanged(({ payload }) => {
      if (!cancelled) setFocused(payload);
    }).then(unlisten => {
      if (cancelled) unlisten();
      else cleanupRef.current.push(unlisten);
    });

    return () => {
      cancelled = true;
      cleanupRef.current.forEach(fn => fn());
      cleanupRef.current = [];
    };
  }, [shouldRender]);

  if (!shouldRender) return null;

  const win = getCurrentWindow();

  if (isMac && position === "left") {
    return (
      <div className={`traffic-lights ${focused ? "" : "unfocused"}`}>
        <button
          className="traffic-light traffic-close"
          onClick={() => win.close()}
          title="Close"
        />
        <button
          className="traffic-light traffic-minimize"
          onClick={() => win.minimize()}
          title="Minimize"
        />
        <button
          className="traffic-light traffic-maximize"
          onClick={() => win.toggleMaximize()}
          title={maximized ? "Restore" : "Maximize"}
        />
      </div>
    );
  }

  if (!isMac && position === "right") {
    return (
      <div className="window-controls">
        <button
          className="window-control-btn window-control-minimize"
          onClick={() => win.minimize()}
          title="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0" y="4" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          className="window-control-btn window-control-maximize"
          onClick={() => win.toggleMaximize()}
          title={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M2 0h6v2h2v6H8v2H0V4h2V0zm1 1v2h5v5h1V2H3zM1 5v4h6V5H1z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0" y="0" width="10" height="10" stroke="currentColor" strokeWidth="1" fill="none" />
            </svg>
          )}
        </button>
        <button
          className="window-control-btn window-control-close"
          onClick={() => win.close()}
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    );
  }

  return null;
}
