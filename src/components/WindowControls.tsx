import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const isMac = navigator.platform.includes("Mac");

// Module-level singleton listeners to avoid strict mode / HMR listener leaks.
// Tauri event listeners are registered once and shared across all subscribers.
let listenersInitialized = false;
let maximized = false;
let focused = true;
const subscribers = new Set<() => void>();

function notify() {
  subscribers.forEach(fn => fn());
}

function initListeners() {
  if (listenersInitialized) return;
  listenersInitialized = true;
  const win = getCurrentWindow();
  win.isMaximized().then(v => { maximized = v; notify(); }).catch(() => {});
  win.isFocused().then(v => { focused = v; notify(); }).catch(() => {});
  win.onResized(() => {
    win.isMaximized().then(v => { maximized = v; notify(); }).catch(() => {});
  });
  win.onFocusChanged(({ payload }) => {
    focused = payload;
    notify();
  });
}

function subscribe(cb: () => void) {
  initListeners();
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

function getMaximized() { return maximized; }
function getFocused() { return focused; }

interface WindowControlsProps {
  position: "left" | "right";
}

export function WindowControls({ position }: WindowControlsProps) {
  const shouldRender = (isMac && position === "left") || (!isMac && position === "right");
  const isMaximized = useSyncExternalStore(shouldRender ? subscribe : noopSubscribe, getMaximized);
  const isFocused = useSyncExternalStore(shouldRender ? subscribe : noopSubscribe, getFocused);

  if (!shouldRender) return null;

  const win = getCurrentWindow();

  if (isMac && position === "left") {
    return (
      <div className={`traffic-lights ${isFocused ? "" : "unfocused"}`}>
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
          title={isMaximized ? "Restore" : "Maximize"}
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
          title={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? (
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

function noopSubscribe() { return () => {}; }
