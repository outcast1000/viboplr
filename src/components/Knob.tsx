import { useRef } from "react";
import { knobClamp, knobQuantize, valueToAngle, dragDeltaToValue, HALF_SWEEP } from "../utils/knob";

interface KnobProps {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  /** Value applied on double-click / reset. Defaults to 0 clamped into range. */
  defaultValue?: number;
  /** When false, the dial renders muted (e.g. EQ disabled) but stays interactive. */
  active?: boolean;
  disabled?: boolean;
  size?: number;
  onChange: (v: number) => void;
  formatValue?: (v: number) => string;
  title?: string;
}

// Bipolar rotary knob driven by pointer drag (vertical), wheel, and arrow keys —
// no external dependency. Zero sits at 12 o'clock; the fill arc grows toward the
// current value so the deviation direction reads at a glance. Pure value↔angle
// math lives in utils/knob.ts (unit-tested).

function polar(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

function arcPath(cx: number, cy: number, r: number, a1: number, a2: number): string {
  if (Math.abs(a2 - a1) < 0.01) return "";
  const [x1, y1] = polar(cx, cy, r, a1);
  const [x2, y2] = polar(cx, cy, r, a2);
  const large = Math.abs(a2 - a1) > 180 ? 1 : 0;
  const sweep = a2 > a1 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export function Knob({
  value, min, max, step, label,
  defaultValue, active = true, disabled = false, size = 30,
  onChange, formatValue, title,
}: KnobProps) {
  const dragRef = useRef<{ startY: number; startVal: number } | null>(null);
  const reset = defaultValue ?? knobClamp(0, min, max);

  function quantize(v: number): number {
    return knobQuantize(v, min, max, step);
  }

  const valueAngle = valueToAngle(value, min, max);
  const zeroAngle = valueToAngle(knobClamp(0, min, max), min, max);

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 3;
  const [tipX, tipY] = polar(cx, cy, r - 1, valueAngle);

  function handlePointerDown(e: React.PointerEvent) {
    if (disabled) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startVal: value };
    e.preventDefault();
  }
  function handlePointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const deltaPx = d.startY - e.clientY; // up = increase
    onChange(quantize(d.startVal + dragDeltaToValue(deltaPx, min, max)));
  }
  function handlePointerUp(e: React.PointerEvent) {
    dragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  }
  function handleWheel(e: React.WheelEvent) {
    if (disabled) return;
    onChange(quantize(value + (e.deltaY < 0 ? step : -step)));
  }
  function handleKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      onChange(quantize(value + step));
      e.preventDefault();
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      onChange(quantize(value - step));
      e.preventDefault();
    }
  }

  const text = formatValue ? formatValue(value) : String(value);

  return (
    <div className={`ds-knob${disabled ? " ds-knob--disabled" : ""}${active ? " ds-knob--active" : ""}`}>
      <div
        className="ds-knob-dial"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${text} dB`}
        title={title ?? `${label}: ${text} dB`}
        style={{ width: size, height: size }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={() => !disabled && onChange(reset)}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <path className="ds-knob-track" d={arcPath(cx, cy, r, -HALF_SWEEP, HALF_SWEEP)} />
          <path className="ds-knob-fill" d={arcPath(cx, cy, r, zeroAngle, valueAngle)} />
          <line className="ds-knob-pointer" x1={cx} y1={cy} x2={tipX.toFixed(2)} y2={tipY.toFixed(2)} />
        </svg>
        <span className="ds-knob-val">{text}</span>
      </div>
      <span className="ds-knob-label">{label}</span>
    </div>
  );
}
