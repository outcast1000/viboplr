import { useRef, useEffect, useCallback } from "react";

interface WaveformSeekBarProps {
  peaks: number[];
  progress: number; // 0..1
  /** Cursor position over the track as a 0..1 fraction, or null when not hovering.
   *  Drives the scrub preview: forward spans get an accent ghost tint, rewind
   *  spans are dimmed, and a hairline marks the target position. */
  hoverPct?: number | null;
}

/** Fraction of the height where the mirror axis sits — the main lobe renders
 *  above it, the quieter reflection below (SoundCloud-style asymmetry). */
const AXIS_RATIO = 0.62;

/** Minimum *painted* bar width (px), excluding the gap. The bar count is packed
 *  as high as the width allows without any painted bar dropping below this. */
const MIN_BAR_WIDTH_PX = 3;
/** Gap between bars, as a fraction of each bar's slot. */
const BAR_GAP_RATIO = 0.2;

/** Aggregate a fine source peak array down to `target` bars by averaging each
 *  span, so one width-independent cached array renders at any bar count. */
function downsamplePeaks(peaks: number[], target: number): number[] {
  if (target >= peaks.length) return peaks;
  const out = new Array<number>(target);
  for (let i = 0; i < target; i++) {
    const start = Math.floor((i * peaks.length) / target);
    const end = Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / target));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end && j < peaks.length; j++) {
      sum += peaks[j];
      n++;
    }
    out[i] = n > 0 ? sum / n : 0;
  }
  return out;
}

function getSkinColors(canvas: HTMLCanvasElement) {
  const style = getComputedStyle(canvas);
  return {
    accent: style.getPropertyValue("--accent-rgb").trim() || "83, 168, 255",
    base: style.getPropertyValue("--overlay-base").trim() || "255, 255, 255",
    inverse: style.getPropertyValue("--overlay-inverse").trim() || "0, 0, 0",
  };
}

export function WaveformSeekBar({ peaks, progress, hoverPct = null }: WaveformSeekBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);

  // Grow-in animation state
  const growRef = useRef(0); // 0 to 1 (animation progress)
  const growStartRef = useRef(0); // timestamp
  const prevPeaksKeyRef = useRef("");
  const GROW_DURATION = 400; // ms
  const STAGGER_PER_BAR = 2; // ms per bar
  const MAX_STAGGER_SPAN = 600; // ms — cap total stagger so high bar counts still reveal promptly

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const c = getSkinColors(canvas);
    // Fit as many bars as the width allows without dropping below the minimum
    // bar width, then downsample the fine source peaks to that many bars.
    // Cap the count so each painted bar (after the gap) stays ≥ MIN_BAR_WIDTH_PX.
    const maxBars = Math.max(1, Math.floor((w * (1 - BAR_GAP_RATIO)) / MIN_BAR_WIDTH_PX));
    const bars = peaks.length > maxBars ? downsamplePeaks(peaks, maxBars) : peaks;
    const barCount = bars.length;
    // Compress the per-bar stagger so the total reveal span stays bounded even
    // for high bar counts.
    const stagger = Math.min(STAGGER_PER_BAR, MAX_STAGGER_SPAN / barCount);
    const totalBarWidth = w / barCount;
    const gap = Math.max(0.5, totalBarWidth * BAR_GAP_RATIO);
    const barWidth = totalBarWidth - gap;
    const axis = h * AXIS_RATIO;
    const topMax = axis - 2;
    const botMax = h - axis - 2;
    const playedX = progress * w;
    const hoverX = hoverPct != null ? hoverPct * w : null;

    const playedGrad = ctx.createLinearGradient(0, 0, 0, axis);
    playedGrad.addColorStop(0, `rgba(${c.accent}, 0.95)`);
    playedGrad.addColorStop(1, `rgba(${c.accent}, 0.55)`);

    // Compute grow animation elapsed time
    const elapsed = performance.now() - growStartRef.current;

    for (let i = 0; i < barCount; i++) {
      const x = i * totalBarWidth + gap / 2;

      // Apply per-bar grow factor with stagger
      let eased = 1;
      if (growRef.current < 1) {
        const barProgress = Math.min(1, Math.max(0, (elapsed - i * stagger) / GROW_DURATION));
        eased = barProgress < 1 ? 1 - Math.pow(1 - barProgress, 3) : 1; // ease-out cubic
      }

      const topH = Math.max(2, bars[i] * topMax * eased);
      const botH = Math.max(1, bars[i] * botMax * eased);
      const played = x + barWidth <= playedX;
      // Forward scrub: ghost-tint the span between the playhead and the cursor
      const ghosted = !played && hoverX != null && hoverX > playedX && x + barWidth <= hoverX;

      ctx.fillStyle = played ? playedGrad : ghosted ? `rgba(${c.accent}, 0.3)` : `rgba(${c.base}, 0.15)`;
      ctx.fillRect(x, axis - topH, barWidth, topH);

      ctx.fillStyle = played ? `rgba(${c.accent}, 0.28)` : ghosted ? `rgba(${c.accent}, 0.14)` : `rgba(${c.base}, 0.08)`;
      ctx.fillRect(x, axis + 1, barWidth, botH);
    }

    // Rewind scrub: dim the span that would become unplayed
    if (hoverX != null && hoverX < playedX) {
      ctx.fillStyle = `rgba(${c.inverse}, 0.35)`;
      ctx.fillRect(hoverX, 0, playedX - hoverX, h);
    }

    // Hairline at the hover target
    if (hoverX != null) {
      ctx.fillStyle = `rgba(${c.base}, 0.7)`;
      ctx.fillRect(hoverX - 0.5, 0, 1, h);
    }

    // Playhead needle with a soft glow — stays on the actual position so the
    // hover hairline and the playhead never get confused
    ctx.save();
    ctx.shadowColor = `rgba(${c.accent}, 0.9)`;
    ctx.shadowBlur = 6;
    ctx.fillStyle = `rgba(${c.accent}, 0.95)`;
    ctx.fillRect(playedX - 0.75, 2, 1.5, h - 4);
    ctx.restore();

    // Check if animation is still running
    const totalDuration = GROW_DURATION + barCount * stagger;
    if (elapsed < totalDuration) {
      growRef.current = elapsed / totalDuration;
      frameRef.current = requestAnimationFrame(draw);
    } else {
      growRef.current = 1;
    }
  }, [peaks, progress, hoverPct]);

  // Detect peak data change and trigger grow animation
  const peaksKey = peaks.length > 0 ? `${peaks.length}:${peaks[0]}:${peaks[peaks.length - 1]}` : "";
  useEffect(() => {
    if (peaksKey && peaksKey !== prevPeaksKeyRef.current) {
      prevPeaksKeyRef.current = peaksKey;
      growRef.current = 0;
      growStartRef.current = performance.now();
    }
  }, [peaksKey]);

  useEffect(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, [draw]);

  // Re-fit the bar count to the canvas width on any layout-driven resize — not
  // just window resizes (e.g. queue panel toggling, sidebar collapse). draw()
  // reads canvas.clientWidth fresh, so a redraw is all that's needed.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(draw);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}
