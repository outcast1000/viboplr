import { useRef, useEffect, useCallback } from "react";

interface SegmentedSeekBarProps {
  progress: number; // 0..1
  durationSecs: number;
}

const GROW_DURATION = 400;
const STAGGER_PER_BAR = 2;
const GAP = 1.5;
const MIN_SEG_WIDTH = 3;
const PADDING = 3;
const RADIUS = 2;
/** Mirror axis (fraction of height): bright lobe above, dim reflection below.
 *  Matches WaveformSeekBar so the no-waveform fallback reads the same. */
const AXIS_RATIO = 0.62;

function getSkinColors(canvas: HTMLCanvasElement) {
  const style = getComputedStyle(canvas);
  const accent = style.getPropertyValue("--accent-rgb").trim() || "83, 168, 255";
  const overlay = style.getPropertyValue("--overlay-base").trim() || "255, 255, 255";
  return {
    playedTop: `rgba(${accent}, 0.5)`,
    playedBot: `rgba(${accent}, 0.24)`,
    unplayedTop: `rgba(${overlay}, 0.12)`,
    unplayedBot: `rgba(${overlay}, 0.06)`,
  };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, stroke?: string) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

export function SegmentedSeekBar({ progress, durationSecs }: SegmentedSeekBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);
  const growRef = useRef(0);
  const growStartRef = useRef(0);
  const prevDurationRef = useRef(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || durationSecs <= 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
    }

    ctx.clearRect(0, 0, w, h);

    // Blocks are real time units, laid out proportional to time so their edges
    // land on exact marks: clicking the start of a block seeks to that exact
    // second/minute. One block per second, or per minute when seconds would
    // pack below the min width. The final block is the leftover remainder, so
    // it's narrower than a full block (it does NOT stretch to a full unit).
    const unit = (1 / durationSecs) * w - GAP < MIN_SEG_WIDTH ? 60 : 1;
    const segCount = Math.ceil(durationSecs / unit);

    const colors = getSkinColors(canvas);
    const playedX = progress * w;
    const axis = h * AXIS_RATIO;
    const topMax = axis - PADDING;
    const botMax = h - axis - PADDING;

    const elapsed = performance.now() - growStartRef.current;

    for (let i = 0; i < segCount; i++) {
      // Time-proportional bounds: block i spans [i·unit, (i+1)·unit) seconds,
      // clamped to the track end (so the last block is the remainder).
      const x = ((i * unit) / durationSecs) * w;
      const segEnd = (Math.min((i + 1) * unit, durationSecs) / durationSecs) * w;
      const segWidth = Math.max(1, segEnd - x - GAP);

      // Grow animation with stagger
      let eased = 1;
      if (growRef.current < 1) {
        const barProgress = Math.min(1, Math.max(0, (elapsed - i * STAGGER_PER_BAR) / GROW_DURATION));
        eased = barProgress < 1 ? 1 - Math.pow(1 - barProgress, 3) : 1;
      }

      const topH = Math.max(1, topMax * eased);
      const botH = Math.max(1, botMax * eased);
      const rTop = Math.min(RADIUS, segWidth / 2, topH / 2);
      const rBot = Math.min(RADIUS, segWidth / 2, botH / 2);

      // Bright upper lobe + dim lower reflection, split at the mirror axis.
      const drawSeg = (top: string, bot: string) => {
        ctx.fillStyle = top;
        roundRect(ctx, x, axis - topH, segWidth, topH, rTop);
        ctx.fillStyle = bot;
        roundRect(ctx, x, axis + 1, segWidth, botH, rBot);
      };

      if (playedX <= x) {
        drawSeg(colors.unplayedTop, colors.unplayedBot);
      } else if (playedX >= segEnd) {
        drawSeg(colors.playedTop, colors.playedBot);
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, 0, playedX - x, h);
        ctx.clip();
        drawSeg(colors.playedTop, colors.playedBot);
        ctx.restore();

        ctx.save();
        ctx.beginPath();
        ctx.rect(playedX, 0, segEnd - playedX, h);
        ctx.clip();
        drawSeg(colors.unplayedTop, colors.unplayedBot);
        ctx.restore();
      }
    }

    const totalDuration = GROW_DURATION + segCount * STAGGER_PER_BAR;
    if (elapsed < totalDuration) {
      growRef.current = elapsed / totalDuration;
      frameRef.current = requestAnimationFrame(draw);
    } else {
      growRef.current = 1;
    }
  }, [progress, durationSecs]);

  // Re-trigger grow animation on track change
  useEffect(() => {
    if (durationSecs !== prevDurationRef.current) {
      prevDurationRef.current = durationSecs;
      growRef.current = 0;
      growStartRef.current = performance.now();
    }
  }, [durationSecs]);

  useEffect(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, [draw]);

  useEffect(() => {
    const onResize = () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(draw);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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
