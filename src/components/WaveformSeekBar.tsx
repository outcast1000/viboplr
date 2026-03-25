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

    for (let i = 0; i < barCount; i++) {
      const x = i * totalBarWidth + gap / 2;
      const barH = Math.max(minBarHeight, peaks[i] * maxBarHeight);
      const y = (h - barH) / 2;

      ctx.fillStyle = x + barWidth <= playedX ? accentColor : dimColor;
      ctx.fillRect(x, y, barWidth, barH);
    }
  }, [peaks, progress, accentColor, dimColor]);

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
