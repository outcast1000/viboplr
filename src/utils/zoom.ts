// Interface-zoom primitives: preset ladder, pure clamp/step helpers, and the
// single point that applies a zoom factor to the webview. Whole-UI zoom scales
// fonts, spacing, and layout together (a webview-level primitive — no CSS), so
// the app keeps one knob for the full window and one for the mini player.
//
// Pure helpers live here (unit-tested in __tests__/zoom.test.ts); applyWebviewZoom
// is the lone side-effecting export, used by useMiniMode (mode transitions) and
// App.tsx (startup restore + hotkeys/Settings while in full mode).
import { getCurrentWebview } from "@tauri-apps/api/webview";

export interface ZoomPresetOption {
  value: number;
  label: string;
}

// Ascending. Modest range so a small window doesn't get cramped at the top end.
export const ZOOM_PRESET_OPTIONS: ZoomPresetOption[] = [
  { value: 0.9, label: "Small" },
  { value: 1, label: "Default" },
  { value: 1.15, label: "Large" },
  { value: 1.3, label: "Extra Large" },
];

export const ZOOM_PRESETS: number[] = ZOOM_PRESET_OPTIONS.map(o => o.value);

/** Snap an arbitrary factor to the nearest preset on the ladder. */
export function clampZoomToPreset(value: number): number {
  if (!Number.isFinite(value)) return 1;
  let best = ZOOM_PRESETS[0];
  let bestDist = Infinity;
  for (const p of ZOOM_PRESETS) {
    const d = Math.abs(p - value);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

/**
 * Step to the neighbouring preset. `dir` is +1 (larger) or -1 (smaller).
 * Clamps at the ends of the ladder (no wrap).
 */
export function stepZoomPreset(current: number, dir: 1 | -1): number {
  const snapped = clampZoomToPreset(current);
  const idx = ZOOM_PRESETS.indexOf(snapped);
  const next = Math.max(0, Math.min(ZOOM_PRESETS.length - 1, idx + dir));
  return ZOOM_PRESETS[next];
}

/** Apply a zoom factor to the current webview. Best-effort: logs on failure. */
export async function applyWebviewZoom(factor: number): Promise<void> {
  try {
    await getCurrentWebview().setZoom(factor);
  } catch (e) {
    console.error("Failed to set webview zoom:", e);
  }
}
