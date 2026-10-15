import { useRef } from "react";
import { useSpin } from "../hooks/useSpin";
import "./SpinningDisc.css";

/**
 * The canonical "currently playing" indicator used across the app
 * (now-playing mini bar, Library/Search track rows, Queue panel).
 * A vinyl disc that spins while playing and, on pause, slows to a stop like a
 * turntable (see useSpin — the rotation is driven from JS, not CSS).
 * Inherits color from `currentColor` so each surface's accent applies.
 */
export function SpinningDisc({ size = 14, playing }: { size?: number; playing: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  useSpin(svgRef, playing, 1800);
  return (
    <span className={`spinning-disc${playing ? " playing" : ""}`}>
      <svg ref={svgRef} width={size} height={size} viewBox="0 0 12 12" fill="none" className="spinning-disc-svg" aria-hidden="true">
        <circle cx="6" cy="6" r="5.5" fill="currentColor" />
        <path d="M6 0.8 A5.2 5.2 0 0 1 11.2 6 L9 6 A3 3 0 0 0 6 3 Z" className="spinning-disc-sheen" />
        <circle cx="6" cy="6" r="4" fill="none" className="spinning-disc-groove" strokeWidth="0.4" />
        <circle cx="6" cy="6" r="2.6" fill="none" className="spinning-disc-groove" strokeWidth="0.4" />
        <circle cx="6" cy="6" r="1.4" fill="var(--bg-primary)" />
        <circle cx="6" cy="6" r="0.5" fill="currentColor" />
      </svg>
    </span>
  );
}
