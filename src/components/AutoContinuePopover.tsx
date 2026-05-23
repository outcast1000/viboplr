import { useEffect, useRef } from "react";
import type { AutoContinueWeights } from "../hooks/useAutoContinue";
import "./AutoContinuePopover.css";

const SLIDERS: { key: keyof AutoContinueWeights; label: string }[] = [
  { key: "random", label: "Random" },
  { key: "sameArtist", label: "Same Artist" },
  { key: "sameTag", label: "Same Tag" },
  { key: "mostPlayed", label: "Most Played" },
  { key: "liked", label: "Liked" },
];

interface Props {
  enabled: boolean;
  sameFormat: boolean;
  weights: AutoContinueWeights;
  onToggle: () => void;
  onToggleSameFormat: () => void;
  onAdjust: (key: keyof AutoContinueWeights, value: number) => void;
  onResetAll: () => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function AutoContinuePopover({
  enabled, sameFormat, weights,
  onToggle, onToggleSameFormat, onAdjust, onResetAll,
  onClose, anchorRef,
}: Props) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Match any popover or anchor in the DOM, since this component may be
      // mounted twice (NowPlayingBar + FullscreenControls share state).
      if (target.closest(".auto-continue-popover")) return;
      if (target.closest(".auto-continue-wrapper")) return;
      onClose();
    }
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  }, [onClose, anchorRef]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="auto-continue-popover" ref={popoverRef} role="dialog" aria-label="Auto Continue">
      <div className="ac-popover-header">
        <label className="ac-toggle-label">
          <input
            type="checkbox"
            checked={enabled}
            onChange={onToggle}
          />
          <span>Auto Continue {enabled ? "On" : "Off"}</span>
        </label>
        <label className="ac-toggle-label">
          <input
            type="checkbox"
            checked={sameFormat}
            onChange={onToggleSameFormat}
          />
          <span>Same format</span>
        </label>
      </div>

      <div className="ac-sliders">
        {SLIDERS.map(({ key, label }) => (
          <div className="ac-slider-row" key={key}>
            <span className="ac-slider-label">{label}</span>
            <input
              className="ac-slider"
              type="range"
              min={0}
              max={100}
              value={weights[key]}
              onChange={e => onAdjust(key, parseInt(e.target.value, 10))}
              aria-label={label}
            />
            <span className="ac-slider-value">{weights[key]}%</span>
          </div>
        ))}
      </div>

      <div className="ac-popover-footer">
        <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={onResetAll}>
          Reset all
        </button>
      </div>
    </div>
  );
}
