import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import "./WindowControls.css";

const isMac = navigator.platform.includes("Mac");

interface WindowControlsProps {
  position: "left" | "right";
  minimizeToMiniPlayer?: boolean;
  onMinimizeToMini?: () => void;
}

/**
 * Tracks whether the app window is maximized.
 *
 * Read back from the window rather than flipped locally when the button is
 * clicked, because that button is only one of the ways in and out: double-
 * clicking the caption bar, Win+Up / Win+Down, dragging the window against the
 * top edge (Aero Snap), dragging a maximized window back down, and
 * `applyWindowFullscreen`'s own unmaximize/maximize around fullscreen all change
 * the state without it being touched. A locally toggled flag desynchronises on
 * the first of those and then shows the wrong glyph until the next click.
 */
function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // Not from a render-body `getCurrentWindow()`: that returns a fresh object
    // each call, so depending on it would re-subscribe on every render.
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    // A drag-resize emits a resize event per frame and each query is an IPC
    // round trip, so keep one in flight at a time — but always re-query after
    // the last event, or the final answer can be the state before it.
    let querying = false;
    let stale = false;

    const sync = () => {
      if (querying) {
        stale = true;
        return;
      }
      querying = true;
      win
        .isMaximized()
        .then((m) => {
          if (!disposed) setMaximized(!!m);
        })
        .catch((e) => console.error("Failed to read the window maximized state:", e))
        .finally(() => {
          querying = false;
          if (stale && !disposed) {
            stale = false;
            sync();
          }
        });
    };

    sync();
    win
      .onResized(sync)
      .then((fn) => {
        // Unmounting before this resolves would otherwise leak the listener.
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("Failed to watch window resizes:", e));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return maximized;
}

/**
 * Windows/Linux caption buttons. Split out from `WindowControls` so the
 * maximized-state subscription is only mounted on the platform that renders
 * them — the component is also rendered for the macOS position, where it
 * returns null and has no use for the listener.
 */
function WindowsCaptionButtons({ minimizeToMiniPlayer, onMinimizeToMini }: Omit<WindowControlsProps, "position">) {
  const win = getCurrentWindow();
  const maximized = useWindowMaximized();
  // The maximize button is a toggle, so it names and draws what it will do
  // next: the platform's "restore down" pair of squares once maximized.
  const maximizeLabel = maximized ? "Restore" : "Maximize";

  return (
    <div className="window-controls">
      <button className="window-control-btn window-control-minimize" onClick={() => minimizeToMiniPlayer && onMinimizeToMini ? onMinimizeToMini() : win.minimize()} title="Minimize" aria-label="Minimize">
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="4" width="10" height="1" fill="currentColor" /></svg>
      </button>
      <button className="window-control-btn window-control-maximize" onClick={() => win.toggleMaximize()} title={maximizeLabel} aria-label={maximizeLabel}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10">
            {/* Only the exposed L of the square behind, so the two don't double up. */}
            <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" strokeWidth="1" fill="none" />
            <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" stroke="currentColor" strokeWidth="1" fill="none" /></svg>
        )}
      </button>
      <button className="window-control-btn window-control-close" onClick={() => win.close()} title="Close" aria-label="Close">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
    </div>
  );
}

export function WindowControls({ position, minimizeToMiniPlayer, onMinimizeToMini }: WindowControlsProps) {
  const shouldRender = (isMac && position === "left") || (!isMac && position === "right");

  if (!shouldRender) return null;

  const win = getCurrentWindow();

  if (isMac && position === "left") {
    return (
      <div className="traffic-lights">
        <button className="traffic-light traffic-close" onClick={() => win.close()} title="Close" aria-label="Close" />
        <button className="traffic-light traffic-minimize" onClick={() => minimizeToMiniPlayer && onMinimizeToMini ? onMinimizeToMini() : win.minimize()} title="Minimize" aria-label="Minimize" />
        <button className="traffic-light traffic-maximize" onClick={() => win.toggleMaximize()} title="Maximize" aria-label="Maximize" />
      </div>
    );
  }

  return <WindowsCaptionButtons minimizeToMiniPlayer={minimizeToMiniPlayer} onMinimizeToMini={onMinimizeToMini} />;
}
