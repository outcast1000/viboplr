/**
 * Compact counts for one-line stat surfaces (detail-header title lines, the
 * Now Playing cycler): 999 → "999", 10 412 → "10.4k", 2 160 000 → "2.2M",
 * 1 200 000 000 → "1.2B". One decimal below 100 of a tier, none above, and a
 * trailing ".0" is dropped ("12k", never "12.0k").
 *
 * Values that would *round* into the next tier take that tier ("999,700" →
 * "1M", never "1000k") — the `0.9995` gate is the top tier's own 0-digit
 * rounding point, so a higher tier always claims a value before a lower one
 * could print four digits.
 *
 * Renderers pairing this with the exact number (a `title` tooltip) keep the
 * precision available on hover. Counts only: non-finite/negative → "0".
 */
export function formatCompactCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const tiers: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [div, suffix] of tiers) {
    const scaled = n / div;
    if (scaled < 0.9995) continue;
    const digits = scaled >= 99.95 ? 0 : 1;
    return scaled.toFixed(digits).replace(/\.0$/, "") + suffix;
  }
  return String(Math.round(n));
}

/**
 * A small ratio like plays-per-listener: one decimal ("12.3"), whole
 * numbers past 100 ("142"), trailing ".0" dropped. Non-finite/zero → null so
 * callers can skip the segment entirely.
 */
export function formatAverage(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 99.95 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "");
}
