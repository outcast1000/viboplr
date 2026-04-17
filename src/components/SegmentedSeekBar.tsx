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

const PLAYED_SEC = "rgba(83, 168, 255, 0.45)";
const UNPLAYED_SEC = "rgba(255, 255, 255, 0.08)";
const PLAYED_MIN = "rgba(100, 160, 255, 0.45)";
const UNPLAYED_MIN = "rgba(255, 255, 255, 0.08)";

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

    const playedColor = minuteMode ? PLAYED_MIN : PLAYED_SEC;
    const unplayedColor = minuteMode ? UNPLAYED_MIN : UNPLAYED_SEC;
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
      const isPlayed = (x + segWidth / 2) < playedX;

      ctx.fillStyle = isPlayed ? playedColor : unplayedColor;

      const r = Math.min(RADIUS, segWidth / 2, currentH / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + segWidth - r, y);
      ctx.quadraticCurveTo(x + segWidth, y, x + segWidth, y + r);
      ctx.lineTo(x + segWidth, y + currentH - r);
      ctx.quadraticCurveTo(x + segWidth, y + currentH, x + segWidth - r, y + currentH);
      ctx.lineTo(x + r, y + currentH);
      ctx.quadraticCurveTo(x, y + currentH, x, y + currentH - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.fill();
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
