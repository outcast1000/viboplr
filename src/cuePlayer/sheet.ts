// The Community site's cue-sheet player (`main.tsx`) reads a published sheet
// from its page. Pure, so what it accepts and how long it runs are tested
// without a DOM (`__tests__/cuePlayerSheet.test.ts`).
//
// A sheet on the site is whatever its publisher's app sent: the site checks
// the shape of `cues` but not the clip fields (boxes, colours, motion), which
// the app's own backend normalizes on import. So this reads defensively — a
// cue whose timing is unusable is dropped, numbers that aren't finite are
// removed rather than passed on as NaN, and everything else is left to the
// same renderer the app uses, which treats text as text.

import type { Cue, CueBeats, CueCamera, CueSheetMode } from "../utils/cueSheet";

export interface PlayerSheet {
  title: string;
  artistName: string | null;
  author: string | null;
  mode: CueSheetMode;
  cues: Cue[];
  camera?: CueCamera[];
  beats?: CueBeats;
  /** How long the player runs, seconds. */
  length: number;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** Drop every non-finite number from a plain object, one level deep (a box, a keyframe). */
function finiteFields<T extends object>(o: unknown): T | undefined {
  if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out as T;
}

function readCue(raw: unknown): Cue | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (!finite(c.at) || c.at < 0) return null;
  const cue = { ...c } as unknown as Cue;
  if (c.until !== undefined && (!finite(c.until) || c.until <= c.at)) delete (cue as { until?: number }).until;
  for (const k of ["size", "opacity", "dim", "layer"] as const) {
    if (c[k] !== undefined && !finite(c[k])) delete (cue as unknown as Record<string, unknown>)[k];
  }
  if (c.box !== undefined) {
    const box = finiteFields<NonNullable<Cue["box"]>>(c.box);
    const ok = box && (["x", "y", "w", "h"] as const).every((k) => finite((box as Record<string, unknown>)[k]));
    if (ok) cue.box = box;
    else delete cue.box;
  }
  if (Array.isArray(c.keyframes)) {
    cue.keyframes = c.keyframes
      .map((k) => finiteFields<NonNullable<Cue["keyframes"]>[number]>(k))
      .filter((k): k is NonNullable<Cue["keyframes"]>[number] => !!k && finite((k as { t?: unknown }).t));
  } else delete cue.keyframes;
  // Only https pictures: the player page allows nothing else, and an http one
  // would be blocked as mixed content anyway — better no <img> than a broken one.
  if (typeof c.imageUrl === "string" && !/^https:\/\//i.test(c.imageUrl)) delete cue.imageUrl;
  return cue;
}

/** Seconds a cue stays up when it doesn't say (the app's own default). */
const DEFAULT_SECS = 10;

/** When the last element leaves — the run time of a sheet whose song length isn't known. */
export function lastCueEnd(cues: Cue[]): number {
  let end = 0;
  for (const c of cues) end = Math.max(end, c.until ?? c.at + DEFAULT_SECS);
  return end;
}

/** The page's embedded item → a playable sheet, or null when there is nothing to play. */
export function readSheet(raw: unknown): PlayerSheet | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const s = r.sheet as Record<string, unknown> | undefined;
  if (!s || !Array.isArray(s.cues)) return null;
  const cues = s.cues.map(readCue).filter((c): c is Cue => c !== null).sort((a, b) => a.at - b.at);
  if (cues.length === 0) return null;
  const camera = Array.isArray(s.camera)
    ? s.camera.filter((m): m is CueCamera => !!m && typeof m === "object" && finite((m as CueCamera).at) && finite((m as CueCamera).until))
    : undefined;
  const b = s.beats as CueBeats | undefined;
  const beats = b && finite(b.bpm) && b.bpm > 0 && finite(b.offset) ? b : undefined;
  const duration = finite(r.durationSecs) && r.durationSecs > 0 ? r.durationSecs : null;
  return {
    title: text(r.title) ?? "Cue sheet",
    artistName: text(r.artistName),
    author: text(r.author),
    mode: s.mode === "clip" ? "clip" : "cards",
    cues,
    camera: camera && camera.length > 0 ? camera : undefined,
    beats,
    length: Math.max(1, duration ?? lastCueEnd(cues)),
  };
}

/** m:ss for the player's clock. */
export function formatClock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Where the clock is `elapsedMs` after it started at `fromSecs`, held at the end. */
export function clockAt(fromSecs: number, elapsedMs: number, length: number): number {
  return Math.min(length, Math.max(0, fromSecs + elapsedMs / 1000));
}
