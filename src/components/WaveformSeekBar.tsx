import { useRef, useEffect, useCallback } from "react";

interface WaveformSeekBarProps {
  peaks: number[];
  progress: number; // 0..1
  accentColor: string;
  dimColor: string;
}

export function WaveformSeekBar({ peaks, progress, accentColor, dimColor }: WaveformSeekBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);

  // Grow-in animation state
  const growRef = useRef(0); // 0 to 1 (animation progress)
  const growStartRef = useRef(0); // timestamp
  const prevPeaksLenRef = useRef(0);
  const GROW_DURATION = 400; // ms
  const STAGGER_PER_BAR = 2; // ms per bar

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
      ctx.scale(dpr, dpr);
    }

    ctx.clearRect(0, 0, w, h);

    const barCount = peaks.length;
    const totalBarWidth = w / barCount;
    const gap = Math.max(0.5, totalBarWidth * 0.2);
    const barWidth = totalBarWidth - gap;
    const minBarHeight = 2;
    const maxBarHeight = h * 0.85;
    const playedX = progress * w;

    // Compute grow animation elapsed time
    const elapsed = performance.now() - growStartRef.current;

    for (let i = 0; i < barCount; i++) {
      const x = i * totalBarWidth + gap / 2;

      // Apply per-bar grow factor with stagger
      let eased = 1;
      if (growRef.current < 1) {
        const barProgress = Math.min(1, Math.max(0, (elapsed - i * STAGGER_PER_BAR) / GROW_DURATION));
        eased = barProgress < 1 ? 1 - Math.pow(1 - barProgress, 3) : 1; // ease-out cubic
      }

      const barH = Math.max(minBarHeight, peaks[i] * maxBarHeight * eased);
      const y = (h - barH) / 2;

      ctx.fillStyle = x + barWidth <= playedX ? accentColor : dimColor;
      ctx.fillRect(x, y, barWidth, barH);
    }

    // Check if animation is still running
    const totalDuration = GROW_DURATION + peaks.length * STAGGER_PER_BAR;
    if (elapsed < totalDuration) {
      growRef.current = elapsed / totalDuration;
      frameRef.current = requestAnimationFrame(draw);
    } else {
      growRef.current = 1;
    }
  }, [peaks, progress, accentColor, dimColor]);

  // Detect peak data change and trigger grow animation
  useEffect(() => {
    if (peaks.length > 0 && peaks.length !== prevPeaksLenRef.current) {
      prevPeaksLenRef.current = peaks.length;
      growRef.current = 0;
      growStartRef.current = performance.now();
    }
  }, [peaks.length]);

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
