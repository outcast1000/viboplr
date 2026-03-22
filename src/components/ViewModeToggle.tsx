import type { ViewMode } from "../types";

interface ViewModeToggleProps {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

export function ViewModeToggle({ mode, onChange }: ViewModeToggleProps) {
  return (
    <div className="view-mode-toggle">
      <button
        className={`view-mode-btn${mode === "basic" ? " active" : ""}`}
        onClick={() => onChange("basic")}
        title="Basic view"
      >{"\u2261"}</button>
      <button
        className={`view-mode-btn${mode === "list" ? " active" : ""}`}
        onClick={() => onChange("list")}
        title="List view"
      >{"\u2630"}</button>
      <button
        className={`view-mode-btn${mode === "tiles" ? " active" : ""}`}
        onClick={() => onChange("tiles")}
        title="Tiles view"
      >{"\u229E"}</button>
    </div>
  );
}
