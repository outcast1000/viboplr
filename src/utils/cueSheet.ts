// Cue sheets: timed text/image cues for one song, written by an assistant
// through the control API (PUT /v1/cues) and played back over the Now
// Playing art by `components/CueOverlay.tsx`. The Rust side
// (`src-tauri/src/db/cue_sheets.rs`) validates and normalizes every sheet
// before storing it, so what arrives here is already sorted and well-formed;
// this module only decides what is on screen at a given second.

export type CueKind = "text" | "quote" | "image";

export interface Cue {
  /** Seconds into the track the cue appears. */
  at: number;
  /** Seconds it leaves; default `at + DEFAULT_CUE_SECS`, cut short by the next cue. */
  until?: number;
  kind: CueKind;
  /** text: the fact / note. quote: the lyric line or words being highlighted. */
  text?: string;
  /** quote: what the line means. image: what the picture shows. */
  caption?: string;
  /** Short eyebrow over the card ("Meaning", "Recording", "Trivia"). */
  label?: string;
  /** image: an http(s) URL. */
  imageUrl?: string;
}

export interface CueSheet {
  cues: Cue[];
}

export interface CueSheetRow {
  title: string;
  artistName: string | null;
  sheet: CueSheet;
  source: string | null;
  updatedAt: number;
}

/** How long a cue without `until` stays up. Long enough to read a sentence
 *  over music without it feeling like a slideshow. */
export const DEFAULT_CUE_SECS = 10;

/** When a cue stops showing: its own `until`, else the default dwell — but
 *  never past the next cue's start, so two cues never stack. */
export function cueEnd(cues: Cue[], index: number): number {
  const cue = cues[index];
  const own = cue.until ?? cue.at + DEFAULT_CUE_SECS;
  const next = cues[index + 1];
  return next && next.at < own ? next.at : own;
}

/** Index of the cue on screen at `positionSecs`, or -1. `cues` is sorted by
 *  `at` (the backend normalizes it so). Linear on purpose: a sheet is capped
 *  at 200 cues and this runs at the ~4 Hz position tick. */
export function activeCueIndex(cues: Cue[], positionSecs: number): number {
  for (let i = cues.length - 1; i >= 0; i--) {
    if (cues[i].at <= positionSecs) {
      return positionSecs < cueEnd(cues, i) ? i : -1;
    }
  }
  return -1;
}

/** Is a cue-sheet change event about this track? Keys are compared the way
 *  the backend keys sheets (case- and accent-insensitive). */
export function sameCueSong(
  a: { title: string; artistName?: string | null },
  b: { title: string; artistName?: string | null },
): boolean {
  const norm = (s: string | null | undefined) =>
    (s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
  return norm(a.title) === norm(b.title) && norm(a.artistName) === norm(b.artistName);
}

/** How to write a sheet — served with the context (GET /v1/cues/context) so
 *  the assistant reads the contract next to the material it is working from,
 *  rather than from a tool description it may have skimmed. */
export const CUE_SHEET_GUIDE = [
  "A cue sheet is { cues: [...] } — timed cards shown over the album art on the Now Playing screen while this song plays. One card at a time; a cue stays up until its `until`, else 10 seconds, and always gives way to the next cue.",
  "Each cue: { at: seconds, until?: seconds, kind: 'text' | 'quote' | 'image', text?, caption?, label?, imageUrl? }.",
  "kind 'text': a short fact in `text` (≤ 400 chars, aim for one or two sentences) — where it was recorded, who plays what, what was happening in the band's life.",
  "kind 'quote': the lyric words being sung in `text` and what they mean in `caption` (≤ 200 chars). Time it to the synced lyric line (`lyrics.lines[].at`), a beat after the line starts.",
  "kind 'image': `imageUrl` must be an https URL you are confident exists (a Wikimedia Commons photo, the artist's own site); `caption` says what it shows. Never invent a URL — leave images out rather than guess.",
  "`label` is an optional 1–3 word eyebrow ('Meaning', 'Recording', 'Trivia').",
  "Ground every cue in the supplied material (lyrics, prose, quality, tags) or knowledge you are sure of; do not state guesses as facts.",
  "Pace it: leave the first ~10 seconds and instrumental gaps quiet or use them for context; 6–15 cues suit a typical song; never cover a line with an unrelated card.",
  "Save with the cue_sheet tool (action=set; PUT /v1/cues) using the same title/artistName; it replaces any earlier sheet and returns the normalized sheet.",
].join(" ");
