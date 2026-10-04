// Cue sheets: timed text/image cues for one song, written by an assistant
// through the control API (PUT /v1/cues) and played back over the Now
// Playing art by `components/CueOverlay.tsx`. The Rust side
// (`src-tauri/src/db/cue_sheets.rs`) validates and normalizes every sheet
// before storing it, so what arrives here is already sorted and well-formed;
// this module only decides what is on screen at a given second.

export type CueKind = "text" | "quote" | "image" | "shape";

/** `cards`: one captioned card at a time over the art column (the default).
 *  `clip`: positioned, animated elements over the whole Now Playing view — a
 *  text-and-image video clip, played by `components/CueClipOverlay.tsx` with
 *  the motion maths in `utils/cueClip.ts`. */
export type CueSheetMode = "cards" | "clip";

/** A colour: a skin-safe token, or a hex the backend has already validated. */
export type CueColor = "light" | "dark" | "accent" | "muted" | `#${string}`;

export type CueEnterEffect =
  | "none" | "fade" | "slide-up" | "slide-down" | "slide-left" | "slide-right"
  | "zoom-in" | "zoom-out" | "blur" | "typewriter" | "words";
export type CueExitEffect = Exclude<CueEnterEffect, "typewriter" | "words">;
export type CueDuringEffect =
  | "none" | "ken-burns" | "drift-up" | "drift-down" | "drift-left" | "drift-right" | "zoom-slow" | "pulse";
export type CueEase = "linear" | "in" | "out" | "in-out";

export interface CueKeyframe {
  /** Seconds after the cue's `at`. */
  t: number;
  /** Offset from the box position, in percent of the view's width / height. */
  x?: number;
  y?: number;
  scale?: number;
  opacity?: number;
  /** Degrees. */
  rotate?: number;
  /** Easing into this keyframe from the previous one. */
  ease?: CueEase;
}

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

  // Clip mode only (ignored by the cards overlay):
  /** Where the element sits, in percent of the view: top-left x/y, width/height. */
  box?: { x: number; y: number; w: number; h: number };
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  /** Text height in percent of the view's height. */
  size?: number;
  /** image: how the picture fills its box. */
  fit?: "cover" | "contain" | "fill";
  /** Stacking order, -10..10; equal layers stack in sheet order. */
  layer?: number;
  opacity?: number;
  color?: CueColor;
  /** What fills the box behind the content. */
  background?: "none" | "scrim" | "card" | "solid";
  backgroundColor?: CueColor;
  weight?: "regular" | "bold";
  italic?: boolean;
  case?: "normal" | "upper";
  /** Text shadow; defaults on when there is no background. */
  shadow?: boolean;
  /** Darken everything under the clip (the art) while this cue is up, 0..0.95. */
  dim?: number;
  enter?: { effect: CueEnterEffect; duration?: number };
  exit?: { effect: CueExitEffect; duration?: number };
  during?: CueDuringEffect;
  keyframes?: CueKeyframe[];
}

export interface CueSheet {
  mode?: CueSheetMode;
  cues: Cue[];
}

export interface CueSheetRow {
  title: string;
  artistName: string | null;
  sheet: CueSheet;
  source: string | null;
  updatedAt: number;
  /** Save responses only: fields the backend dropped (`ignored_fields`). */
  warnings?: string[];
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

/** Every field name a sheet error can name — the closed set telemetry may
 *  report. Mirrors the fields `db/cue_sheets.rs` validates. */
const CUE_FIELDS = new Set([
  "at", "until", "kind", "text", "caption", "label", "imageUrl", "box", "align", "valign", "size", "fit",
  "layer", "opacity", "color", "backgroundColor", "background", "weight", "italic", "case", "shadow", "dim",
  "enter", "exit", "during", "keyframes",
]);

/** Which field a cue-sheet rejection was about, for anonymous telemetry:
 *  a name from `CUE_FIELDS`, `sheet` for sheet-level errors, else `other`.
 *  Never echoes the message — it can quote the author's text. */
export function cueErrorField(message: string): string {
  const m = /^cues\[\d+\](?:\.([A-Za-z]+))?/.exec(message);
  if (m) return m[1] && CUE_FIELDS.has(m[1]) ? m[1] : m[1] ? "other" : "cue";
  return /^sheet/.test(message) ? "sheet" : "other";
}

/** Coarse cue-count label for telemetry. */
export function cueCountBucket(n: number): string {
  return n < 10 ? "1-9" : n < 30 ? "10-29" : n < 100 ? "30-99" : "100+";
}

/** The first cue that starts at or past the song's end, as an error naming
 *  it — or null. The backend can't check this (it never learns the duration),
 *  and the likeliest author mistake it catches is milliseconds for seconds:
 *  such a sheet saves fine and then never shows a single card. Reads the raw
 *  request sheet, so anything malformed is left for the backend to name. */
export function cuePastEndError(sheet: unknown, durationSecs: number | null | undefined): string | null {
  if (!durationSecs || !Number.isFinite(durationSecs) || durationSecs <= 0) return null;
  const cues = Array.isArray(sheet) ? sheet : (sheet as { cues?: unknown } | null)?.cues;
  if (!Array.isArray(cues)) return null;
  for (let i = 0; i < cues.length; i++) {
    const at = (cues[i] as { at?: unknown } | null)?.at;
    if (typeof at === "number" && at >= durationSecs) {
      return `cues[${i}].at is ${at}s but the song is ${Math.round(durationSecs)}s long — times are seconds into the track, not milliseconds`;
    }
  }
  return null;
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
  "Give every card time to be read — at least 6 seconds, longer for a long text (roughly 2s + 1s per 3 words). A quote card may stay up over the next few sung lines; do not end it when its line ends. Keep cue starts at least 8 seconds apart, and put long text cards in instrumental stretches (gaps between `lyrics.lines`).",
  "`at` and `until` are seconds into the track (e.g. 64.5), never milliseconds or \"m:ss\" strings; a cue past the song's end is rejected.",
  "Save with the cue_sheet tool (action=set; PUT /v1/cues) using the same title/artistName; it replaces any earlier sheet and returns the normalized sheet.",
].join(" ");

/** The clip half of the format (`mode: "clip"`), served next to the cards
 *  guide. Every name here is a closed vocabulary in `db/cue_sheets.rs`. */
export const CUE_CLIP_GUIDE = [
  "CLIP MODE — a text-and-image video clip over the whole Now Playing view. The sheet is { mode: \"clip\", cues: [...] } — the same `cues` array as cards. The lyrics column hides while a clip plays, so a clip that carries the words should show them itself.",
  "Timing: each element stays from `at` to `until` (else 10s), overlapping freely — the next element never cuts one short. Cues at or past the track's end are rejected. The cards pacing rules (one at a time, 8s apart) do not apply; instead keep 1–3 elements on screen and give text time to be read (about 2s + 1s per 3 words; a single-word hit can be shorter). Without `enter` / `exit` an element appears and leaves instantly.",
  "Paint order is `layer` (-10..10), then sheet order. Kinds: 'text'; 'quote' (the words in quote marks, italic, with `caption` underneath in smaller type); 'image' (imageUrl, https only — never invent one; `caption` as a strip along its bottom); 'shape' (a solid block filled with backgroundColor — for colour fields, bars and wipes).",
  "Position: box { x, y, w, h } in percent of the view (x/y = top-left; may go off-view, -100..200, for motion). Default box { x:10, y:10, w:80, h:80 }. align left|center|right (default center) and valign top|middle|bottom (default middle) place content inside the box.",
  "Text: `size` = text height in percent of the view height (default 5; 0.5–40; 4–7 reads as a caption, 10–20 as a title). It is a maximum: if label + text + caption together overflow the box they are shrunk until they fit, so give a title a box wide and tall enough (one line needs h ≥ size + a little; two lines ≥ 2.4 × size). A \"\\n\" in text forces a line break. `label` and `caption` scale from size. weight regular|bold, italic, case normal|upper, shadow (default on when there is no background).",
  "Colour: `color` (text) / `backgroundColor` (fill) = a token — light (bright text), muted (dimmer secondary text, best on dark or dimmed areas), dark, accent (the skin's accent) — or a hex like #ffcc00 / #00000080 when the song calls for a specific colour. Prefer tokens; they stay readable and follow the skin. `background`: none (default) | scrim (translucent dark) | card (blurred panel) | solid (fills the box with backgroundColor).",
  "Images: `fit` cover | contain | fill. An image or shape with box {0,0,100,100} covers the album art completely — the clip replaces the art while it is up. `dim` (0–0.95) darkens the art under the clip while the element is up, fading with it; clip elements always sit above the dim, and overlapping dims don't add up — the strongest one wins.",
  "Motion presets: `enter` / `exit` = an effect name or { effect, duration } — fade, slide-up, slide-down, slide-left, slide-right, zoom-in, zoom-out, blur, none; enter also typewriter (letter by letter) and words (word by word), whose default pace follows the text length. `during` = ken-burns, drift-up/down/left/right, zoom-slow, pulse — continuous motion across the element's life. Default transition 0.4s. Enter, exit, during and keyframes all run together.",
  "Keyframes (custom motion): keyframes: [{ t, x?, y?, scale?, opacity?, rotate?, ease? }] — t in seconds after the element's `at`, x/y offsets from the box in percent of the view, rotate in degrees, ease linear|in|out|in-out into that frame. Scale and rotate turn about the box's centre, for any kind. Before the first keyframe its values hold; after the last, the last ones do. Opacity multiplies: element `opacity` × keyframe opacity × enter/exit fade (a hex colour's own alpha applies on top). Max 32 per element.",
  "If `lyrics.note` is present the synced lyrics were timed to a different version of the song: tell the user, and lean less on exact line timing. The save response lists `warnings` for any field it ignored — fix those and save again.",
  "Make it read like a lyric video: time sung words to `lyrics.lines[].at` (words or typewriter enter), use a few large titles with dim at section changes, keep 1–3 elements on screen, and leave breathing room. Reduced-motion users get the same timing with fades instead of movement.",
].join(" ");
