import { useEffect, useRef } from "react";
import { BANDS, BUILTIN_PRESETS, type EqPreset } from "../eqPresets";

interface Props {
  enabled: boolean;
  preset: string;
  gains: number[];
  customPresets: EqPreset[];
  onEnabledChange: (v: boolean) => void;
  onPresetChange: (id: string) => void;
  onGainChange: (bandIndex: number, gainDb: number) => void;
  onResetAll: () => void;
  onSaveAs: () => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function EqPopover({
  enabled, preset, gains, customPresets,
  onEnabledChange, onPresetChange, onGainChange,
  onResetAll, onSaveAs, onClose, anchorRef,
}: Props) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleDown(e: MouseEvent) {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
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

  function formatHz(hz: number): string {
    if (hz >= 1000) return `${hz / 1000}k`;
    return `${hz}`;
  }

  function presetSelectValue(): string {
    return preset === "custom" ? "custom" : preset;
  }

  return (
    <div className="eq-popover" ref={popoverRef} role="dialog" aria-label="Equalizer">
      <div className="eq-popover-header">
        <label className="eq-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => onEnabledChange(e.target.checked)}
          />
          <span>EQ {enabled ? "On" : "Off"}</span>
        </label>
        <select
          className="ds-select eq-preset-select"
          value={presetSelectValue()}
          onChange={e => onPresetChange(e.target.value)}
        >
          <optgroup label="Built-in">
            {BUILTIN_PRESETS.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </optgroup>
          {customPresets.length > 0 && (
            <optgroup label="Custom">
              {customPresets.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </optgroup>
          )}
          {preset === "custom" && (
            <option value="custom">Custom (unsaved)</option>
          )}
        </select>
        <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={onSaveAs}>
          Save as…
        </button>
      </div>

      <div className="eq-bands">
        {BANDS.map((hz, i) => (
          <div className="eq-band" key={hz}>
            <div className="eq-band-readout">{gains[i].toFixed(1)}</div>
            <input
              className="eq-band-slider"
              type="range"
              min={-15}
              max={15}
              step={0.5}
              value={gains[i]}
              onChange={e => onGainChange(i, parseFloat(e.target.value))}
              onDoubleClick={() => onGainChange(i, 0)}
              aria-label={`${hz} Hz`}
            />
            <div className="eq-band-label">{formatHz(hz)}</div>
          </div>
        ))}
      </div>

      <div className="eq-popover-footer">
        <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={onResetAll}>
          Reset all
        </button>
      </div>
    </div>
  );
}
