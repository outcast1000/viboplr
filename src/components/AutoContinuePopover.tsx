import type { AutoContinueWeights } from "../hooks/useAutoContinue";

const SLIDERS: { key: keyof AutoContinueWeights; label: string }[] = [
  { key: "random", label: "Random" },
  { key: "sameArtist", label: "Same Artist" },
  { key: "sameTag", label: "Same Tag" },
  { key: "mostPlayed", label: "Most Played" },
  { key: "liked", label: "Liked" },
];

interface AutoContinuePopoverProps {
  enabled: boolean;
  weights: AutoContinueWeights;
  onToggle: () => void;
  onAdjust: (key: keyof AutoContinueWeights, value: number) => void;
}

export function AutoContinuePopover({
  enabled, weights, onToggle, onAdjust,
}: AutoContinuePopoverProps) {
  return (
    <div className="auto-continue-popover" onClick={(e) => e.stopPropagation()}>
      <div className="ac-toggle" onClick={onToggle}>
        <span>Auto Continue</span>
        <span className={`ac-toggle-indicator ${enabled ? "ac-on" : ""}`}>
          {enabled ? "ON" : "OFF"}
        </span>
      </div>
      {SLIDERS.map(({ key, label }) => (
        <div className="ac-slider-row" key={key}>
          <span className="ac-slider-label">{label}</span>
          <input
            type="range"
            min="0"
            max="100"
            value={weights[key]}
            onChange={(e) => onAdjust(key, parseInt(e.target.value, 10))}
          />
          <span className="ac-slider-value">{weights[key]}%</span>
        </div>
      ))}
    </div>
  );
}
