// Named cue-sheet styles, served with the cue context (GET /v1/cues/context)
// as `styles`. The format guides (`CUE_SHEET_GUIDE` / `CUE_CLIP_GUIDE`) say
// *how* to write cues; a style says *what kind of sheet* to write — the beats
// it tells, in what order, and how it lays them out. An assistant offers the
// user the styles that fit the song (unless they already said what they want)
// and follows the chosen one's recipe on top of the format guide.
//
// Recipes are prose for the model, not a layout engine: they name boxes and
// presets from the clip vocabulary in `cue_sheets.rs`, and the guide's pacing
// and grounding rules still apply. `fits` is computed from what the context
// actually holds, so a style that needs synced lyrics is never offered for a
// song that has none.

import type { CueContextLyrics, CueContextProse } from "./cueContext";
import type { CueSheetMode } from "./cueSheet";

/** What a style needs from the context to be worth offering. */
export type CueStyleNeed = "syncedLyrics" | "lyrics" | "songStory" | "anyStory" | "images";

export interface CueStyle {
  id: string;
  name: string;
  mode: CueSheetMode;
  /** One sentence the assistant can offer the user as is. */
  pitch: string;
  /** Hard requirements — without them the style is not offered. */
  needs: CueStyleNeed[];
  /** Nice to have — the style works without them, with less to show. */
  prefers: CueStyleNeed[];
  recipe: string;
}

/** A style as the context serves it: its fit to this song worked out. */
export interface CueStyleOffer {
  id: string;
  name: string;
  mode: CueSheetMode;
  pitch: string;
  fits: boolean;
  /** What the song lacks, in words: hard needs when `fits` is false, else
   *  preferences it would be richer with. Empty when nothing is missing. */
  missing: string[];
  recipe: string;
}

const NEED_LABEL: Record<CueStyleNeed, string> = {
  syncedLyrics: "synced lyrics",
  lyrics: "lyrics",
  songStory: "a song story or meaning",
  anyStory: "a song, artist or album text",
  images: "photos",
};

/** The shared layout the clip styles build on, so they read as one family. */
const CLIP_LAYOUT =
  "Layout: sung words in the middle, box {x:6,y:46,w:88,h:22}, size 6–7, bold, enter words, exit fade 0.3, layer 2 — each line from its `lines[].at` until just before the next line (cap ~6.5s), \\n to break a long line. Story panels pinned to the top, box {x:5,y:5,w:90,h:26}, align left, valign top, size 3.4, background card, enter slide-down, exit fade, layer 4, with a 1–2 word label. Photos full-bleed under everything, box {0,0,100,100}, fit cover, during ken-burns, 1.2s fades, layer -5, credit in the caption.";

export const CUE_STYLES: CueStyle[] = [
  {
    id: "storyteller",
    name: "Storyteller",
    mode: "clip",
    pitch: "A lyric video that tells the song's story — what the band was going through, why they wrote it, what the lines refer to, and how people took it.",
    needs: ["syncedLyrics", "anyStory"],
    prefers: ["songStory", "images"],
    recipe: [
      "Arc, in order: (1) Opening, before the first line: a title card — the song in big type (size 14–16, bold, dim 0.8, zoom-out enter, blur exit) with 'Artist · Album · Year' under it in muted — then a band photo with the era panel (where the band was at the time: the previous record, the label, the lineup, what was at stake), then 'The spark' (why or from what the song was written) as large centred text, words enter, dim 0.65, ending as the vocal starts.",
      "(2) Verses: every sung line on screen; over the lines worth explaining, a top panel with what they mean or refer to (a quote, an answer to another song, a person) — label Meaning / Reference / Sarcasm / Allusion. Hedge what the material hedges ('possibly', 'may echo').",
      "(3) Instrumental gaps carry the long stories, each over a photo: influences and the sound; a guest or a key player; reception (chart placings, reviews, controversy, sales); legacy (later rankings, who it influenced, what it led to). Use the gap lengths to decide which fit where — about 2s + 1s per 3 words each.",
      "(4) The hook: when the title or chorus word is sung as a chant, flash it huge (size 16–20, accent, dim 0.75, zoom-in, during pulse) and clip the lyric line before it so they never overlap.",
      "(5) Close on the last lines with a coda panel that ties back to the spark — what the song finally says. No end card after the music.",
      CLIP_LAYOUT,
      "Keep the top panel and the lyric line from ever overlapping each other's boxes, and keep 1–3 elements on screen. Every fact from the context or knowledge you are sure of; when a claim comes from a fan annotation, say so ('possibly').",
    ].join(" "),
  },
  {
    id: "annotated",
    name: "Annotated",
    mode: "cards",
    pitch: "Line-by-line notes on what the lyrics mean and refer to, as they're sung.",
    needs: ["lyrics", "songStory"],
    prefers: ["syncedLyrics"],
    recipe: [
      "Mostly quote cards: pick the 6–12 lines with the most behind them — a reference, a double meaning, a person, a place — and put the line in `text` and its meaning in `caption`, a beat after the line starts (label Meaning / Reference / Wordplay).",
      "One opening text card before the vocal with what the song is about in a sentence; at most one closing card. No band history beyond what a line needs.",
      "Without synced lyrics, place cards by the song's structure (verse every ~30s) and say so to the user.",
    ].join(" "),
  },
  {
    id: "translation",
    name: "Translation",
    mode: "clip",
    pitch: "Every sung line with its translation underneath — for a song in a language the listener doesn't speak.",
    needs: ["syncedLyrics"],
    prefers: ["songStory"],
    recipe: [
      "Offer it only when the lyrics are in a language other than the one the user writes to you in; translate into the user's language.",
      "Each line as a quote element in the middle (box {x:6,y:40,w:88,h:30}): the original in `text`, the translation in `caption`, enter fade, from its `lines[].at` until just before the next line. Translate for meaning, not word for word; keep names, and add a short note in the top panel (layout below) for an idiom or reference that doesn't carry over.",
      "Open with a title card and one panel on what the song is about; transliterate nothing unless asked.",
      CLIP_LAYOUT,
    ].join(" "),
  },
  {
    id: "pop-up-trivia",
    name: "Pop-up trivia",
    mode: "cards",
    pitch: "Short, surprising facts popping up through the song — the studio, the gear, the odd details.",
    needs: ["anyStory"],
    prefers: ["images"],
    recipe: [
      "8–14 text cards, each one fact of one or two sentences, label Trivia / Recording / Gear / Did you know. Favour the specific and surprising over the summary: a take count, an instrument, a borrowed riff, a misheard lyric, a cameo.",
      "Spread them evenly, at least 8s apart; a card may sit over a sung line but never an unrelated quote. One or two image cards from `images` if there are any.",
    ].join(" "),
  },
  {
    id: "lyric-video",
    name: "Lyric video",
    mode: "clip",
    pitch: "Just the words, in motion — no commentary.",
    needs: ["syncedLyrics"],
    prefers: [],
    recipe: [
      "Every sung line, no story panels. Lines in the middle (layout below) with words or typewriter enter; vary the size with the delivery — a shouted line bigger, a whisper smaller and muted.",
      "A title card at the start, and at each section change (verse → chorus) a short dim (0.5–0.7) or a full-bleed accent shape wipe. Repeat the chorus hook huge when it lands. Leave instrumental stretches empty or hold one photo there.",
      CLIP_LAYOUT,
    ].join(" "),
  },
  {
    id: "liner-notes",
    name: "Liner notes",
    mode: "cards",
    pitch: "The record-sleeve view: who played what, where it was recorded, who produced it and how it sounds.",
    needs: ["anyStory"],
    prefers: ["images"],
    recipe: [
      "6–10 text cards in the order a sleeve reads: the record it is from and when; the lineup and who plays what on this track; the studio and the producer/engineer; the sound — tunings, instruments, the arrangement; the copy you are hearing (`track.quality`).",
      "Label each (Album / Personnel / Recording / Sound / This copy). Credits only from the context or knowledge you are sure of — a credit you can't vouch for is left out, not guessed. Long cards in instrumental gaps.",
    ].join(" "),
  },
];

interface StyleMaterial {
  lyrics: CueContextLyrics | null;
  prose: CueContextProse[];
  imageCount: number;
}

function has(need: CueStyleNeed, m: StyleMaterial): boolean {
  switch (need) {
    case "syncedLyrics": return m.lyrics?.kind === "synced" && (m.lyrics.lines?.length ?? 0) > 0;
    case "lyrics": return m.lyrics != null;
    case "songStory": return m.prose.some((p) => p.about === "song");
    case "anyStory": return m.prose.length > 0;
    case "images": return m.imageCount > 0;
  }
}

/** Every style with its fit to this song, fitting ones first (catalogue order
 *  otherwise), so an assistant offering "the first few that fit" gets the
 *  right ones. */
export function cueStylesFor(m: StyleMaterial, styles: CueStyle[] = CUE_STYLES): CueStyleOffer[] {
  const offers = styles.map((s) => {
    const lacking = s.needs.filter((n) => !has(n, m));
    const fits = lacking.length === 0;
    const missing = (fits ? s.prefers.filter((n) => !has(n, m)) : lacking).map((n) => NEED_LABEL[n]);
    return { id: s.id, name: s.name, mode: s.mode, pitch: s.pitch, fits, missing, recipe: s.recipe };
  });
  return [...offers.filter((o) => o.fits), ...offers.filter((o) => !o.fits)];
}

/** How to use `styles` — served next to them. */
export const CUE_STYLE_GUIDE =
  "`styles` are kinds of sheet, fitting ones first. If the user already said what they want, pick the closest style yourself (or none, if nothing is close) without asking. Otherwise offer two or three styles whose `fits` is true — by name and pitch, in a sentence each — and let them choose. Follow the chosen style's `recipe` on top of `guide` (cards) or `clipGuide` (clip), in its `mode`; the guide's pacing and grounding rules still apply. `missing` names what this song lacks for a style: a reason it doesn't fit, or something it would be richer with.";
