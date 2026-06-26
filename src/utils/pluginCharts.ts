// Pure, DOM-free helpers backing the plugin chart render kinds
// (`bar-chart`, `heatmap`, `line-chart`) in PluginViewRenderer. Kept dependency-
// free so they can be unit-tested without rendering React.

export type ChartValueFormat = "number" | "percent" | "duration";

function clamp01(x: number): number {
  if (!isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Format a numeric chart value for display. Locale-independent (stable in tests). */
export function formatChartValue(value: number, format?: ChartValueFormat): string {
  if (!isFinite(value)) return "0";
  if (format === "percent") return `${Math.round(value)}%`;
  if (format === "duration") {
    const s = Math.max(0, Math.round(value));
    if (s >= 3600) return `${Math.round((s / 3600) * 10) / 10}h`;
    if (s >= 60) return `${Math.round(s / 60)}m`;
    return `${s}s`;
  }
  // "number" (default): integer with thousands separators.
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Map a value series into SVG coordinates inside a (w × h) box.
 * Index → x across the full width; value → y (top = scale max, bottom = 0).
 * A single point becomes a flat segment; `max <= 0` flattens to the baseline.
 */
export function chartPoints(
  points: number[],
  max: number,
  w: number,
  h: number,
): Array<[number, number]> {
  const n = points.length;
  if (n === 0) return [];
  const m = max > 0 ? max : 1;
  if (n === 1) {
    const y = h - clamp01(points[0] / m) * h;
    return [
      [0, y],
      [w, y],
    ];
  }
  return points.map((v, i) => {
    const x = (i / (n - 1)) * w;
    const y = h - clamp01(v / m) * h;
    return [x, y];
  });
}

function num(n: number): string {
  // Trim floating noise so SVG path strings stay compact.
  return (Math.round(n * 100) / 100).toString();
}

/** SVG path `d` for the polyline through the series. Empty string if no points. */
export function buildLinePath(points: number[], max: number, w: number, h: number): string {
  const pts = chartPoints(points, max, w, h);
  if (pts.length === 0) return "";
  return pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${num(x)} ${num(y)}`).join(" ");
}

/** SVG path `d` for the area under the line, closed down to the baseline. */
export function buildAreaPath(points: number[], max: number, w: number, h: number): string {
  const pts = chartPoints(points, max, w, h);
  if (pts.length === 0) return "";
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${num(x)} ${num(y)}`).join(" ");
  const lastX = num(pts[pts.length - 1][0]);
  const firstX = num(pts[0][0]);
  return `${line} L${lastX} ${num(h)} L${firstX} ${num(h)} Z`;
}

/** Heatmap cell fill opacity (0..1) for a value against the scale max. */
export function heatIntensity(value: number, max: number): number {
  if (max <= 0 || !isFinite(value) || value <= 0) return 0;
  return clamp01(value / max);
}
