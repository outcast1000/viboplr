import { useEffect, useRef } from "react";
import {
  BUILTIN_PRESETS,
  SIMPLE_PRESETS,
  simplePresetFor,
  type EqMode,
  type EqPreset,
} from "../eqPresets";
import { EqCurve } from "./EqCurve";
import { formatDb } from "../utils/eqCurve";

interface Props {
  enabled: boolean;
  mode: EqMode;
  preset: string;
  gains: number[];
  preGainDb: number;
  bassDb: number;
  trebleDb: number;
  customPresets: EqPreset[];
  onEnabledChange: (v: boolean) => void;
  onModeChange: (mode: EqMode) => void;
  onPresetChange: (id: string) => void;
  onGainChange: (bandIndex: number, gainDb: number) => void;
  onPreGainChange: (db: number) => void;
  onBassChange: (db: number) => void;
  onTrebleChange: (db: number) => void;
  onResetAll: () => void;
  onSaveAs: () => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

const CURVE_WIDTH = 564;
const CURVE_HEIGHT = 190;

export function EqPopover({
  enabled, mode, preset, gains, preGainDb, bassDb, trebleDb, customPresets,
  onEnabledChange, onModeChange, onPresetChange, onGainChange, onPreGainChange,
  onBassChange, onTrebleChange, onResetAll, onSaveAs, onClose, anchorRef,
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

  const simple = mode === "simple";
  const ensureEnabled = () => { if (!enabled) onEnabledChange(true); };

  // Active preset chip: simple matches by shelf pair, advanced by gains (via `preset`).
  const activePreset = simple ? simplePresetFor(bassDb, trebleDb) : (preset || "custom");

  function applySimplePreset(id: string) {
    const p = SIMPLE_PRESETS.find((x) => x.id === id);
    if (!p) return;
    ensureEnabled();
    onBassChange(p.bassDb);
    onTrebleChange(p.trebleDb);
  }

  return (
    <div className="eq-popover" ref={popoverRef} role="dialog" aria-label="Equalizer">
      {/* Consolidated header: title · mode · spacer · enable · close */}
      <div className="eq-popover-header">
        <span className="eq-popover-title">Equalizer</span>
        <div className="eq-mode-seg" role="tablist" aria-label="Equalizer mode">
          <button
            className={`eq-mode-seg-btn ${simple ? "active" : ""}`}
            onClick={() => onModeChange("simple")}
            role="tab"
            aria-selected={simple}
          >
            Simple
          </button>
          <button
            className={`eq-mode-seg-btn ${!simple ? "active" : ""}`}
            onClick={() => onModeChange("advanced")}
            role="tab"
            aria-selected={!simple}
          >
            Advanced
          </button>
        </div>
        <div className="eq-header-spacer" />
        <button
          className={`eq-enable-toggle ${enabled ? "on" : ""}`}
          onClick={() => onEnabledChange(!enabled)}
          role="switch"
          aria-checked={enabled}
          title={enabled ? "Disable equalizer" : "Enable equalizer"}
        >
          <span className="eq-enable-track" aria-hidden="true"><span className="eq-enable-thumb" /></span>
          <span className="eq-enable-label">{enabled ? "On" : "Off"}</span>
        </button>
        <button className="eq-popover-close" onClick={onClose} aria-label="Close" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      {/* Interactive response curve — the editor in both modes */}
      <div className="eq-curve-wrap">
        <EqCurve
          enabled={enabled}
          mode={mode}
          gains={gains}
          bassDb={bassDb}
          trebleDb={trebleDb}
          preGainDb={preGainDb}
          width={CURVE_WIDTH}
          height={CURVE_HEIGHT}
          interactive
          showFreqScale
          showHandleFreqLabels={!simple}
          onGainChange={onGainChange}
          onBassChange={onBassChange}
          onTrebleChange={onTrebleChange}
          onEnsureEnabled={ensureEnabled}
        />
      </div>

      {simple && (
        <div className="eq-simple-readouts">
          <span>Bass <b>{formatDb(bassDb)}</b> dB</span>
          <span>Treble <b>{formatDb(trebleDb)}</b> dB</span>
        </div>
      )}

      {/* Presets (chips, both modes) + reset + save */}
      <div className="eq-controls">
        <div className="eq-presets">
          {simple
            ? SIMPLE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={`eq-preset-chip ${activePreset === p.id ? "active" : ""}`}
                  onClick={() => applySimplePreset(p.id)}
                >
                  {p.name}
                </button>
              ))
            : (
              <>
                {BUILTIN_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    className={`eq-preset-chip ${activePreset === p.id ? "active" : ""}`}
                    onClick={() => { ensureEnabled(); onPresetChange(p.id); }}
                  >
                    {p.name}
                  </button>
                ))}
                {customPresets.map((p) => (
                  <button
                    key={p.id}
                    className={`eq-preset-chip ${activePreset === p.id ? "active" : ""}`}
                    onClick={() => { ensureEnabled(); onPresetChange(p.id); }}
                  >
                    {p.name}
                  </button>
                ))}
              </>
            )}
        </div>
        <button className="eq-icon-btn" onClick={onResetAll} title="Reset to flat" aria-label="Reset to flat">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>
        </button>
        {!simple && (
          <button className="eq-icon-btn" onClick={onSaveAs} title="Save as preset" aria-label="Save as preset">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          </button>
        )}
      </div>

      {/* Pre-gain (advanced only) — a master offset, not a per-band curve handle */}
      {!simple && (
        <div className="eq-pregain-row">
          <span className="eq-pregain-label">Pre-gain</span>
          <input
            type="range"
            min={-12}
            max={12}
            step={0.1}
            value={preGainDb}
            onChange={e => { ensureEnabled(); onPreGainChange(parseFloat(e.target.value)); }}
            onDoubleClick={() => onPreGainChange(0)}
            className="eq-pregain-slider"
            aria-label="Pre-gain"
          />
          <span className="eq-pregain-readout">{formatDb(preGainDb)} dB</span>
        </div>
      )}
    </div>
  );
}
