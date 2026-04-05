import { getCurrentWindow } from "@tauri-apps/api/window";
import "./WindowControls.css";

const isMac = navigator.platform.includes("Mac");

interface WindowControlsProps {
  position: "left" | "right";
}

export function WindowControls({ position }: WindowControlsProps) {
  const shouldRender = (isMac && position === "left") || (!isMac && position === "right");

  if (!shouldRender) return null;

  const win = getCurrentWindow();

  if (isMac && position === "left") {
    return (
      <div className="traffic-lights">
        <button className="traffic-light traffic-close" onClick={() => win.close()} title="Close" />
        <button className="traffic-light traffic-minimize" onClick={() => win.minimize()} title="Minimize" />
        <button className="traffic-light traffic-maximize" onClick={() => win.toggleMaximize()} title="Maximize" />
      </div>
    );
  }

  if (!isMac && position === "right") {
    return (
      <div className="window-controls">
        <button className="window-control-btn window-control-minimize" onClick={() => win.minimize()} title="Minimize">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="4" width="10" height="1" fill="currentColor" /></svg>
        </button>
        <button className="window-control-btn window-control-maximize" onClick={() => win.toggleMaximize()} title="Maximize">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" stroke="currentColor" strokeWidth="1" fill="none" /></svg>
        </button>
        <button className="window-control-btn window-control-close" onClick={() => win.close()} title="Close">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button>
      </div>
    );
  }

  return null;
}
