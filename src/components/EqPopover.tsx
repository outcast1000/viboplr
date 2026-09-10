import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BUILTIN_PRESETS,
  SIMPLE_PRESETS,
  simplePresetFor,
  type EqClipProtection,
  type EqMode,
  type EqPreset,
} from "../eqPresets";
import { EqCurve } from "./EqCurve";
import { HelpLink } from "./HelpLink";
import { formatDb } from "../utils/eqCurve";
import "./Eq.css";

interface Props {
  enabled: boolean;
  mode: EqMode;
  preset: string;
  gains: number[];
  preGainDb: number;
  bassDb: number;
  trebleDb: number;
  clipProtection: EqClipProtection;
  customPresets: EqPreset[];
  onEnabledChange: (v: boolean) => void;
  onModeChange: (mode: EqMode) => void;
  onPresetChange: (id: string) => void;
  onGainChange: (bandIndex: number, gainDb: number) => void;
  onPreGainChange: (db: number) => void;
  onBassChange: (db: number) => void;
  onTrebleChange: (db: number) => void;
  onClipProtectionChange: (v: EqClipProtection) => void;
  onResetAll: () => void;
  onSaveAs: () => void;
  showBarControl: boolean;
  onShowBarControlChange: (v: boolean) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

const CURVE_WIDTH = 564;
const CURVE_HEIGHT = 190;
/** Gap between the anchor button and the panel's bottom edge. */
const ANCHOR_GAP_PX = 8;

export function EqPopover({
  enabled, mode, preset, gains, preGainDb, bassDb, trebleDb, clipProtection, customPresets,
  onEnabledChange, onModeChange, onPresetChange, onGainChange, onPreGainChange,
  onBassChange, onTrebleChange, onClipProtectionChange, onResetAll, onSaveAs,
  showBarControl, onShowBarControlChange, onClose, anchorRef,
}: Props) {
  const popoverRef = useRef<HTMLDivElement>(null);
  // Anchored in viewport coordinates rather than to the button's own box,
  // because the panel is portalled out of both bars — see the portal note
  // below. Bottom/right, so it still grows up and to the left off the button
  // exactly as the old `bottom: calc(100% + 8px); right: 0` did.
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null);

  const place = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      bottom: window.innerHeight - rect.top + ANCHOR_GAP_PX,
      right: window.innerWidth - rect.right,
    });
  }, [anchorRef]);

  useLayoutEffect(() => { place(); }, [place]);

  useEffect(() => {
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place]);

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

  // Portalled out of whichever bar mounted it. `z-index` only ever ranks within
  // the nearest stacking context, and in audio fullscreen the whole surface is
  // one (`.audio-fs`, z-index 999) — so in place the panel was capped below the
  // queue drawer (fixed, z-index 1000 at the root) and opened underneath it. The
  // target is `document.fullscreenElement ?? document.body` for the same reason
  // as `SourceIndicator`'s panel: inside DOM `:fullscreen` the browser paints
  // only that subtree, so a panel parked at the app root would never appear over
  // browser-engine fullscreen video.
  return createPortal(
    <div
      className="eq-popover"
      ref={popoverRef}
      role="dialog"
      aria-label="Equalizer"
      style={pos ? { bottom: pos.bottom, right: pos.right } : { visibility: "hidden" }}
    >
      {/* Consolidated header: title · mode · spacer · enable · close */}
      <div className="eq-popover-header">
        <span className="eq-popover-title">Equalizer<HelpLink anchor="equalizer" topic="the equalizer" /></span>
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

      {/* Clip protection (simple only) — how a Bass/Treble boost is kept from
          clipping. Loudness = master-bus limiter (the boost stays loud, but a
          heavy boost pumps on dense music); Fidelity = lower the volume by the
          boost amount (artifact-free, quieter). Advanced mode has manual
          pre-gain instead. */}
      {simple && (
        <div className="eq-barvis-row">
          <span className="eq-barvis-label">Boost clip protection</span>
          <div className="eq-mode-seg" role="radiogroup" aria-label="Boost clip protection">
            <button
              className={`eq-mode-seg-btn ${clipProtection !== "headroom" ? "active" : ""}`}
              onClick={() => onClipProtectionChange("limiter")}
              role="radio"
              aria-checked={clipProtection !== "headroom"}
              title="Limit boosted peaks — boosts stay loud, but a heavy boost can pump on dense music"
            >
              Loudness
            </button>
            <button
              className={`eq-mode-seg-btn ${clipProtection === "headroom" ? "active" : ""}`}
              onClick={() => onClipProtectionChange("headroom")}
              role="radio"
              aria-checked={clipProtection === "headroom"}
              title="Lower the volume by the boost amount — no limiter artifacts, but quieter"
            >
              Fidelity
            </button>
          </div>
        </div>
      )}

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

      {/* Visibility of the inline EQ control in the now-playing bar — stored per mode */}
      <div className="eq-barvis-row">
        <span className="eq-barvis-label">Show {simple ? "Simple" : "Advanced"} controls in player bar</span>
        <button
          className={`eq-enable-toggle ${showBarControl ? "on" : ""}`}
          onClick={() => onShowBarControlChange(!showBarControl)}
          role="switch"
          aria-checked={showBarControl}
          title={showBarControl ? "Hide inline controls in the player bar" : "Show inline controls in the player bar"}
        >
          <span className="eq-enable-track" aria-hidden="true"><span className="eq-enable-thumb" /></span>
          <span className="eq-enable-label">{showBarControl ? "On" : "Off"}</span>
        </button>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
