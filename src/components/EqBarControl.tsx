import { useRef } from "react";
import { EqCurve } from "./EqCurve";
import { formatDb } from "../utils/eqCurve";
import { GAIN_MIN, GAIN_MAX, type EqMode } from "../eqPresets";

// Inline EQ control that lives in the now-playing bar's audio pill. A single
// fixed-size slot whose contents depend on the EQ mode — so switching modes
// never shifts the bar layout:
//   • simple   → two compact bipolar Bass/Treble sliders (interactive)
//   • advanced → a read-only response-curve preview (edit the 10 bands in the
//                popover via the EQ button)

const SLOT_W = 118;
const SLOT_H = 34;
const STEP = 0.5;

interface EqBarControlProps {
  mode: EqMode;
  enabled: boolean;
  bassDb: number;
  trebleDb: number;
  gains: number[];
  preGainDb: number;
  onBassChange: (db: number) => void;
  onTrebleChange: (db: number) => void;
  onEnsureEnabled: () => void;
}

function clampGain(db: number): number {
  return Math.max(GAIN_MIN, Math.min(GAIN_MAX, Math.round(db / STEP) * STEP));
}

interface BipolarSliderProps {
  label: string;
  ariaLabel: string;
  value: number;
  onChange: (db: number) => void;
  onEnsureEnabled: () => void;
}

function BipolarSlider({ label, ariaLabel, value, onChange, onEnsureEnabled }: BipolarSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);

  function commit(db: number) {
    const v = clampGain(db);
    onEnsureEnabled();
    onChange(v);
  }
  function fromClientX(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const t = (clientX - rect.left) / rect.width;
    commit(GAIN_MIN + t * (GAIN_MAX - GAIN_MIN));
  }
  // Drag with window listeners. The value updates on pointer-down first (so a
  // plain click registers), then move/up track on window. The cleanup closure
  // never touches the pooled React event, so releasing always ends the drag.
  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startVal = value;
    let intent: "set" | "vert" = "set";
    fromClientX(e.clientX);
    const move = (ev: PointerEvent) => {
      const dx = Math.abs(ev.clientX - startX);
      const dy = Math.abs(ev.clientY - startY);
      if (intent === "set" && dy > dx && dy > 4) intent = "vert";
      if (intent === "vert") commit(startVal + ((startY - ev.clientY) / 140) * (GAIN_MAX - GAIN_MIN));
      else fromClientX(ev.clientX);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
  function onKeyDown(e: React.KeyboardEvent) {
    const big = e.shiftKey ? 2 : STEP;
    let handled = true;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") commit(value + big);
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") commit(value - big);
    else if (e.key === "Home") commit(GAIN_MAX);
    else if (e.key === "End") commit(GAIN_MIN);
    else if (e.key === "0" || e.key === "Backspace" || e.key === "Delete") commit(0);
    else handled = false;
    if (handled) e.preventDefault();
  }

  const pct = (value - GAIN_MIN) / (GAIN_MAX - GAIN_MIN); // 0..1
  const zeroPct = 0.5;
  const fillLeft = value >= 0 ? zeroPct : pct;
  const fillWidth = Math.abs(pct - zeroPct);

  return (
    <div className="eqbar-row">
      <span className="eqbar-letter" aria-hidden="true">{label}</span>
      <div
        ref={trackRef}
        className="eqbar-slider"
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuemin={GAIN_MIN}
        aria-valuemax={GAIN_MAX}
        aria-valuenow={value}
        aria-valuetext={`${formatDb(value)} dB`}
        title={`${ariaLabel}: ${formatDb(value)} dB`}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => commit(0)}
        onWheel={(e) => {
          e.preventDefault();
          commit(value + (e.deltaY < 0 ? STEP : -STEP));
        }}
      >
        <div className="eqbar-track" />
        <div className="eqbar-zero" />
        <div className="eqbar-fill" style={{ left: `${fillLeft * 100}%`, width: `${fillWidth * 100}%` }} />
        <div className="eqbar-thumb" style={{ left: `${pct * 100}%` }} />
      </div>
      <span className={`eqbar-val${value === 0 ? " eqbar-val--zero" : ""}`}>{formatDb(value)}</span>
    </div>
  );
}

export function EqBarControl({
  mode,
  enabled,
  bassDb,
  trebleDb,
  gains,
  preGainDb,
  onBassChange,
  onTrebleChange,
  onEnsureEnabled,
}: EqBarControlProps) {
  return (
    <div className={`eqbar-slot${enabled ? "" : " eqbar-slot--off"}`} style={{ width: SLOT_W, height: SLOT_H }}>
      {mode === "simple" ? (
        <div className="eqbar-sliders">
          <BipolarSlider label="B" ariaLabel="Bass" value={bassDb} onChange={onBassChange} onEnsureEnabled={onEnsureEnabled} />
          <BipolarSlider label="T" ariaLabel="Treble" value={trebleDb} onChange={onTrebleChange} onEnsureEnabled={onEnsureEnabled} />
        </div>
      ) : (
        <EqCurve
          enabled={enabled}
          mode="advanced"
          gains={gains}
          bassDb={bassDb}
          trebleDb={trebleDb}
          preGainDb={preGainDb}
          width={SLOT_W}
          height={SLOT_H}
          interactive={false}
        />
      )}
    </div>
  );
}
