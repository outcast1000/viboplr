import { useMemo, useRef } from "react";
import {
  buildCurvePath,
  freqToX,
  dbToY,
  yToDb,
  handlesForMode,
  nearestHandleIndex,
  formatDb,
  Y_MAX_DB,
  type CurveLayout,
  type CurveHandle,
} from "../utils/eqCurve";
import { GAIN_MIN, GAIN_MAX, type EqMode } from "../eqPresets";

const STEP = 0.5;
const COARSE = 2; // Shift+arrow / PageUp-Down step (dB)

interface EqCurveProps {
  enabled: boolean;
  mode: EqMode;
  gains: number[];
  bassDb: number;
  trebleDb: number;
  preGainDb: number;
  width: number;
  height: number;
  /** When false (default) the curve is a static read-only preview. */
  interactive?: boolean;
  /** Left dB scale + horizontal grid lines. Default: same as `interactive`. */
  showDbScale?: boolean;
  /** Bottom frequency-axis labels. Default false (advanced handles label themselves). */
  showFreqScale?: boolean;
  /** Print each handle's frequency below it (advanced curve-only). */
  showHandleFreqLabels?: boolean;
  onGainChange?: (bandIndex: number, db: number) => void;
  onBassChange?: (db: number) => void;
  onTrebleChange?: (db: number) => void;
  /** Called before applying an edit while disabled, so the edit auto-enables EQ. */
  onEnsureEnabled?: () => void;
}

const DB_GRID = [12, 6, 0, -6, -12];
const FREQ_AXIS = [31, 125, 500, 2000, 8000];

function clampGain(db: number): number {
  return Math.max(GAIN_MIN, Math.min(GAIN_MAX, Math.round(db / STEP) * STEP));
}

export function EqCurve({
  enabled,
  mode,
  gains,
  bassDb,
  trebleDb,
  preGainDb,
  width,
  height,
  interactive = false,
  showDbScale,
  showFreqScale = false,
  showHandleFreqLabels = false,
  onGainChange,
  onBassChange,
  onTrebleChange,
  onEnsureEnabled,
}: EqCurveProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dbScale = showDbScale ?? interactive;

  const layout: CurveLayout = useMemo(
    () => ({
      width,
      height,
      padL: dbScale ? 30 : 3,
      padR: dbScale ? 10 : 3,
      padT: dbScale ? 10 : 4,
      padB: showFreqScale ? 20 : 4,
    }),
    [width, height, dbScale, showFreqScale],
  );

  const curve = useMemo(
    () => buildCurvePath({ enabled, mode, gains, preGainDb, bassDb, trebleDb }, layout),
    [enabled, mode, gains, preGainDb, bassDb, trebleDb, layout],
  );

  const handles = useMemo(() => handlesForMode(mode), [mode]);

  function valueOf(h: CurveHandle): number {
    if (h.key === "bass") return bassDb;
    if (h.key === "treble") return trebleDb;
    const idx = Number(h.key.slice(5));
    return gains[idx] ?? 0;
  }

  function setValue(h: CurveHandle, db: number) {
    const v = clampGain(db);
    if (!enabled) onEnsureEnabled?.();
    if (h.key === "bass") onBassChange?.(v);
    else if (h.key === "treble") onTrebleChange?.(v);
    else onGainChange?.(Number(h.key.slice(5)), v);
  }

  // Convert a clientY (px) into a dB value, accounting for any CSS scaling.
  function clientYToDb(clientY: number): number {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const scale = rect.height / height || 1;
    return yToDb((clientY - rect.top) / scale, layout);
  }
  function clientXToCoord(clientX: number): number {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const scale = rect.width / width || 1;
    return (clientX - rect.left) / scale;
  }

  // Drag with window listeners. The value is applied on pointer-down first (so a
  // plain click always registers), then move/up are tracked on window. The
  // cleanup closure references only `el` and the listener fns — never the
  // pooled React event — so releasing always ends the drag.
  function startHandleDrag(h: CurveHandle, e: React.PointerEvent) {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.classList.add("dragging");
    setValue(h, clientYToDb(e.clientY));
    const move = (ev: PointerEvent) => setValue(h, clientYToDb(ev.clientY));
    const up = () => {
      el.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function handleKey(h: CurveHandle, e: React.KeyboardEvent) {
    if (!interactive) return;
    const big = e.shiftKey ? COARSE : STEP;
    const cur = valueOf(h);
    let handled = true;
    switch (e.key) {
      case "ArrowUp":
      case "ArrowRight":
        setValue(h, cur + big);
        break;
      case "ArrowDown":
      case "ArrowLeft":
        setValue(h, cur - big);
        break;
      case "PageUp":
        setValue(h, cur + COARSE);
        break;
      case "PageDown":
        setValue(h, cur - COARSE);
        break;
      case "Home":
        setValue(h, GAIN_MAX);
        break;
      case "End":
        setValue(h, GAIN_MIN);
        break;
      case "0":
      case "Backspace":
      case "Delete":
        setValue(h, 0);
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  // Click on the curve body (not a handle) sets the nearest handle to cursor Y.
  function onSvgPointerDown(e: React.PointerEvent) {
    if (!interactive) return;
    const x = clientXToCoord(e.clientX);
    const idx = nearestHandleIndex(x, handles, layout);
    setValue(handles[idx], clientYToDb(e.clientY));
  }

  return (
    <div
      className={`eq-curve-host${enabled ? "" : " eq-curve-host--disabled"}${interactive ? " eq-curve-host--interactive" : ""}`}
      style={{ width, height }}
    >
      <svg
        ref={svgRef}
        className="eq-curve-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onPointerDown={interactive ? onSvgPointerDown : undefined}
        aria-hidden={!interactive}
      >
        {dbScale &&
          DB_GRID.map((db) => {
            const y = dbToY(db, layout);
            return (
              <g key={`db${db}`}>
                <line
                  className={`eq-curve-grid${db === 0 ? " eq-curve-grid--zero" : ""}`}
                  x1={layout.padL}
                  y1={y}
                  x2={width - layout.padR}
                  y2={y}
                />
                <text className="eq-curve-axis" x={layout.padL - 5} y={y} textAnchor="end" dominantBaseline="middle">
                  {db > 0 ? `+${db}` : db}
                </text>
              </g>
            );
          })}
        {!dbScale && (
          <line
            className="eq-curve-grid eq-curve-grid--zero"
            x1={layout.padL}
            y1={dbToY(0, layout)}
            x2={width - layout.padR}
            y2={dbToY(0, layout)}
          />
        )}
        {showFreqScale &&
          FREQ_AXIS.map((f) => (
            <text
              key={`f${f}`}
              className="eq-curve-axis"
              x={freqToX(f, layout)}
              y={height - 5}
              textAnchor="middle"
            >
              {f >= 1000 ? `${f / 1000}k` : f}
            </text>
          ))}
        <path className="eq-curve-area" d={curve.area} />
        <path className="eq-curve-line" d={curve.line} />
      </svg>

      {interactive &&
        handles.map((h) => {
          const v = valueOf(h);
          const x = freqToX(h.freq, layout);
          const y = dbToY(Math.max(-Y_MAX_DB, Math.min(Y_MAX_DB, v)), layout);
          const isBand = h.key.startsWith("band:");
          return (
            <div
              key={h.key}
              className={`eq-curve-handle${isBand ? " eq-curve-handle--band" : ""}`}
              style={{ left: x, top: y }}
              role="slider"
              tabIndex={0}
              aria-label={h.ariaLabel}
              aria-valuemin={GAIN_MIN}
              aria-valuemax={GAIN_MAX}
              aria-valuenow={v}
              aria-valuetext={`${h.ariaLabel} ${formatDb(v)} dB`}
              title={`${h.ariaLabel}: ${formatDb(v)} dB`}
              onPointerDown={(e) => startHandleDrag(h, e)}
              onKeyDown={(e) => handleKey(h, e)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setValue(h, 0);
              }}
              onWheel={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setValue(h, valueOf(h) + (e.deltaY < 0 ? STEP : -STEP));
              }}
            >
              <span className="eq-curve-handle-tag">{formatDb(v)}</span>
              {!isBand && <span className="eq-curve-handle-glyph">{h.label}</span>}
              {isBand && showHandleFreqLabels && <span className="eq-curve-handle-freq">{h.label}</span>}
            </div>
          );
        })}
    </div>
  );
}
