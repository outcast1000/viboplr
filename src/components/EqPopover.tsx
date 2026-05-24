import { useEffect, useRef, useMemo } from "react";
import { BANDS, BAND_Q, BUILTIN_PRESETS, type EqPreset } from "../eqPresets";

interface Props {
  enabled: boolean;
  preset: string;
  gains: number[];
  preGainDb: number;
  customPresets: EqPreset[];
  onEnabledChange: (v: boolean) => void;
  onPresetChange: (id: string) => void;
  onGainChange: (bandIndex: number, gainDb: number) => void;
  onPreGainChange: (db: number) => void;
  onResetAll: () => void;
  onSaveAs: () => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

const CURVE_WIDTH = 560;
const CURVE_HEIGHT = 180;
const CURVE_PAD_LEFT = 36;
const CURVE_PAD_RIGHT = 12;
const CURVE_PAD_TOP = 8;
const CURVE_PAD_BOTTOM = 8;
const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const Y_MAX_DB = 15;
const SAMPLES = 240;

function freqToX(freq: number): number {
  const innerW = CURVE_WIDTH - CURVE_PAD_LEFT - CURVE_PAD_RIGHT;
  const t = (Math.log10(freq) - Math.log10(FREQ_MIN)) / (Math.log10(FREQ_MAX) - Math.log10(FREQ_MIN));
  return CURVE_PAD_LEFT + t * innerW;
}

function dbToY(db: number): number {
  const innerH = CURVE_HEIGHT - CURVE_PAD_TOP - CURVE_PAD_BOTTOM;
  const t = (Y_MAX_DB - db) / (2 * Y_MAX_DB);
  return CURVE_PAD_TOP + t * innerH;
}

// Single peaking-biquad magnitude response in dB at frequency f.
function peakingResponseDb(f: number, f0: number, q: number, gainDb: number): number {
  if (gainDb === 0) return 0;
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * f0 / 48000;
  const w = 2 * Math.PI * f / 48000;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw0 = Math.cos(w0);
  const b0 = 1 + alpha * A;
  const b1 = -2 * cosw0;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha / A;
  // |H(e^{jw})|^2
  const cosw = Math.cos(w);
  const cos2w = Math.cos(2 * w);
  const numRe = b0 + b1 * cosw + b2 * cos2w;
  const numIm = -(b1 * Math.sin(w) + b2 * Math.sin(2 * w));
  const denRe = a0 + a1 * cosw + a2 * cos2w;
  const denIm = -(a1 * Math.sin(w) + a2 * Math.sin(2 * w));
  const numMagSq = numRe * numRe + numIm * numIm;
  const denMagSq = denRe * denRe + denIm * denIm;
  return 10 * Math.log10(numMagSq / denMagSq);
}

function buildCurvePath(gains: number[], enabled: boolean, preGainDb: number): { area: string; line: string } {
  const pts: Array<[number, number]> = [];
  const logMin = Math.log10(FREQ_MIN);
  const logMax = Math.log10(FREQ_MAX);
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const f = Math.pow(10, logMin + t * (logMax - logMin));
    let totalDb = 0;
    if (enabled) {
      totalDb += preGainDb;
      for (let b = 0; b < BANDS.length; b++) {
        totalDb += peakingResponseDb(f, BANDS[b], BAND_Q, gains[b] ?? 0);
      }
    }
    const clamped = Math.max(-Y_MAX_DB, Math.min(Y_MAX_DB, totalDb));
    pts.push([freqToX(f), dbToY(clamped)]);
  }
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const yZero = dbToY(0);
  const area = `M${pts[0][0].toFixed(1)} ${yZero.toFixed(1)} ` +
    pts.map(p => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ") +
    ` L${pts[pts.length - 1][0].toFixed(1)} ${yZero.toFixed(1)} Z`;
  return { area, line };
}

function formatHz(hz: number): string {
  if (hz >= 1000) return `${hz / 1000}k`;
  return `${hz}`;
}

export function EqPopover({
  enabled, preset, gains, preGainDb, customPresets,
  onEnabledChange, onPresetChange, onGainChange, onPreGainChange,
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

  const curve = useMemo(() => buildCurvePath(gains, enabled, preGainDb), [gains, enabled, preGainDb]);

  const presetSelectValue = preset === "custom" ? "custom" : preset;
  const yLines = [12, 6, 0, -6, -12];
  const innerLeft = CURVE_PAD_LEFT;
  const innerRight = CURVE_WIDTH - CURVE_PAD_RIGHT;

  return (
    <div className="eq-popover" ref={popoverRef} role="dialog" aria-label="Equalizer">
      <div className="eq-popover-titlebar">
        <span className="eq-popover-title">Equalizer</span>
        <button className="eq-popover-close" onClick={onClose} aria-label="Close" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div className="eq-popover-toolbar">
        <label className="eq-toggle">
          <input type="checkbox" checked={enabled} onChange={e => onEnabledChange(e.target.checked)} />
          <span className="eq-toggle-track" aria-hidden="true"><span className="eq-toggle-thumb" /></span>
          <span className="eq-toggle-label">Enable Equalizer</span>
        </label>
        <div className="eq-toolbar-spacer" />
        <select
          className="ds-select eq-preset-select"
          value={presetSelectValue}
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
          {preset === "custom" && <option value="custom">Custom</option>}
        </select>
        <button className="eq-icon-btn" onClick={onResetAll} title="Reset to flat" aria-label="Reset to flat">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>
        </button>
        <button className="eq-icon-btn" onClick={onSaveAs} title="Save as preset" aria-label="Save as preset">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        </button>
      </div>

      <div className="eq-curve-wrap">
        <svg className="eq-curve" viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          {yLines.map(db => (
            <g key={db}>
              <line
                x1={innerLeft} y1={dbToY(db)} x2={innerRight} y2={dbToY(db)}
                className={`eq-grid-line ${db === 0 ? "eq-grid-line--zero" : ""}`}
              />
              <text x={innerLeft - 6} y={dbToY(db)} className="eq-grid-label" textAnchor="end" dominantBaseline="middle">
                {db > 0 ? `+${db}` : db === 0 ? "0" : `${db}`}
              </text>
            </g>
          ))}
          <path d={curve.area} className="eq-curve-area" />
          <path d={curve.line} className="eq-curve-line" />
        </svg>
      </div>

      <div className="eq-bands">
        {BANDS.map((hz, i) => (
          <div className="eq-band" key={hz}>
            <div className="eq-band-readout">{gains[i] >= 0 ? `+${gains[i].toFixed(1)}` : gains[i].toFixed(1)}</div>
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

      <div className="eq-pregain-row">
        <span className="eq-pregain-label">Pre-gain</span>
        <input
          type="range"
          min={-12}
          max={12}
          step={0.1}
          value={preGainDb}
          onChange={e => onPreGainChange(parseFloat(e.target.value))}
          onDoubleClick={() => onPreGainChange(0)}
          className="eq-pregain-slider"
          aria-label="Pre-gain"
        />
        <span className="eq-pregain-readout">{preGainDb >= 0 ? `+${preGainDb.toFixed(1)}` : preGainDb.toFixed(1)} dB</span>
      </div>
    </div>
  );
}
