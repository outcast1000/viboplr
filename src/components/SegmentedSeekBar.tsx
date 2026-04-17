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

function getSkinColors(canvas: HTMLCanvasElement) {
  const style = getComputedStyle(canvas);
  const accent = style.getPropertyValue("--accent-rgb").trim() || "83, 168, 255";
  const overlay = style.getPropertyValue("--overlay-base").trim() || "255, 255, 255";
  return {
    playedSec: `rgba(${accent}, 0.45)`,
    unplayedSec: `rgba(${overlay}, 0.08)`,
    playedMin: `rgba(${accent}, 0.45)`,
    unplayedMin: `rgba(${overlay}, 0.08)`,
    strokeMin: `rgba(${overlay}, 0.12)`,
  };
}

function strokeRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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
  ctx.stroke();
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

    // Determine segment mode: try 1-second first, fall back to 1-minute
    let segmentSecs = 1;
    let segCount = Math.ceil(durationSecs / segmentSecs);
    let totalGaps = (segCount - 1) * GAP;
    let segWidth = (w - totalGaps) / segCount;

    let minuteMode = false;
    if (segWidth < MIN_SEG_WIDTH) {
      segmentSecs = 60;
      segCount = Math.ceil(durationSecs / segmentSecs);
      totalGaps = (segCount - 1) * GAP;
      segWidth = (w - totalGaps) / segCount;
      minuteMode = true;
    }

    const colors = getSkinColors(canvas);
    const playedColor = minuteMode ? colors.playedMin : colors.playedSec;
    const unplayedColor = minuteMode ? colors.unplayedMin : colors.unplayedSec;
    const playedX = progress * w;
    const barH = h - PADDING * 2;

    const elapsed = performance.now() - growStartRef.current;

    for (let i = 0; i < segCount; i++) {
      const x = i * (segWidth + GAP);

      // Grow animation with stagger
      let eased = 1;
      if (growRef.current < 1) {
        const barProgress = Math.min(1, Math.max(0, (elapsed - i * STAGGER_PER_BAR) / GROW_DURATION));
        eased = barProgress < 1 ? 1 - Math.pow(1 - barProgress, 3) : 1;
      }

      const currentH = Math.max(1, barH * eased);
      const y = PADDING + (barH - currentH) / 2;
      const segEnd = x + segWidth;

      const r = Math.min(RADIUS, segWidth / 2, currentH / 2);
      const stroke = minuteMode ? colors.strokeMin : undefined;

      if (playedX <= x) {
        ctx.fillStyle = unplayedColor;
        roundRect(ctx, x, y, segWidth, currentH, r, stroke);
      } else if (playedX >= segEnd) {
        ctx.fillStyle = playedColor;
        roundRect(ctx, x, y, segWidth, currentH, r, stroke);
      } else {
        const splitX = playedX;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, splitX - x, currentH);
        ctx.clip();
        ctx.fillStyle = playedColor;
        roundRect(ctx, x, y, segWidth, currentH, r);
        ctx.restore();

        ctx.save();
        ctx.beginPath();
        ctx.rect(splitX, y, segEnd - splitX, currentH);
        ctx.clip();
        ctx.fillStyle = unplayedColor;
        roundRect(ctx, x, y, segWidth, currentH, r);
        ctx.restore();

        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1;
          strokeRoundRect(ctx, x, y, segWidth, currentH, r);
        }
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
