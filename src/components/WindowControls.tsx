import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const isMac = navigator.platform.includes("Mac");

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (isMac) return;
    const win = getCurrentWindow();
    win.isMaximized().then(setMaximized).catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  if (isMac) return null;

  const win = getCurrentWindow();

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
