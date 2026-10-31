// The material an assistant writes a cue sheet from (GET /v1/cues/context):
// the track's identity and quality, its lyrics (synced lines carry their
// timestamps — the clock every cue is placed on), every prose info value for
// the song / artist / album (bio, review, song story, lyric annotations),
// every gallery image for them (real photos with their credit + licence), its
// library tags, any sheet already saved, the format guide, and the named
// styles (`utils/cueStyles.ts`) with their fit to this song. Everything
// comes through the same provider chain + cache the detail pages use, so a
// value fetched here is free on the next page visit and vice versa.
//
// The gather answers by a deadline (`CUE_CONTEXT_DEADLINE_MS`) rather than
// waiting on the slowest provider: whatever hasn't arrived by then is listed
// in `pending` for the assistant to fetch on its own, and keeps running so it
// lands in the cache for the next ask.

import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";
import type { DisplayKind, ImageGalleryData, InfoEntity, LyricsData } from "../types/informationTypes";
import { fetchInfoValue, resolveInfoEntityId, type InvokeInfoFetch, type InfoTypeRow } from "./infoFetchChain";
import { parseLrc } from "./lyrics";
import { resolveTrackQuality } from "../hooks/useNowPlayingInfo";
import { CUE_CLIP_GUIDE, CUE_SHEET_GUIDE, type CueSheetRow } from "./cueSheet";
import { CUE_STYLE_GUIDE, cueStylesFor, type CueStyleOffer } from "./cueStyles";

/** Display kinds that carry readable prose about an entity. A superset of the
 *  About panel's (`ABOUT_DISPLAY_KINDS`): lyric annotations are noise on a
 *  lean-back panel but exactly what a "what does this line mean" cue needs. */
export const CONTEXT_DISPLAY_KINDS: DisplayKind[] = ["rich_text", "html", "annotated_text", "annotations"];

/** Per-entry cap. A full Last.fm wiki can run to tens of KB; the assistant
 *  needs the substance, and the whole context should fit comfortably in one
 *  tool result. */
export const PROSE_CHAR_CAP = 6000;

/** Display kinds whose values are pictures of an entity. An assistant may only
 *  use image URLs it can trust, so a provider's gallery is the safe source. */
export const CONTEXT_IMAGE_DISPLAY_KINDS: DisplayKind[] = ["image_gallery"];

/** Per-gallery cap — enough to choose from, small enough to keep the context
 *  one tool result. */
export const CONTEXT_IMAGE_CAP = 12;

/** How long the gather waits for providers before answering with what it
 *  has. The control API gives `/v1/cues/context` 70s (`handle_bridge_query_slow`,
 *  7 × the 10s bridge timeout) and answers 504 with nothing past that, so this
 *  stays well inside it — one slow provider (an LLM "Meaning", a stalled
 *  lyrics site) must cost its own value, not the whole context. */
export const CUE_CONTEXT_DEADLINE_MS = 25_000;

const TIMED_OUT = Symbol("timed out");

/** `p`'s value, or `TIMED_OUT` if `deadline` settles first. `p` is not
 *  cancelled: an info fetch still finishes and fills the shared cache. */
function settleBy<T>(p: Promise<T>, deadline: Promise<void>): Promise<T | typeof TIMED_OUT> {
  return Promise.race([p, deadline.then((): typeof TIMED_OUT => TIMED_OUT)]);
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cap(text: string): string {
  return text.length > PROSE_CHAR_CAP ? text.slice(0, PROSE_CHAR_CAP).trimEnd() + " …" : text;
}

/** Plain text of one prose info value, or null when it carries none. */
export function proseText(displayKind: DisplayKind | string, value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? htmlToText(x) : "");
  let text = "";
  switch (displayKind) {
    case "rich_text":
      text = str(v.full) || str(v.summary);
      break;
    case "html":
      text = str(v.content);
      break;
    case "annotated_text": {
      const parts = [str(v.overview)];
      if (Array.isArray(v.sections)) {
        for (const s of v.sections as Array<Record<string, unknown>>) {
          const body = str(s?.text);
          if (body) parts.push(s?.heading ? `${str(s.heading)}: ${body}` : body);
        }
      }
      text = parts.filter(Boolean).join("\n\n");
      break;
    }
    case "annotations": {
      const parts = [str(v.overview)];
      if (Array.isArray(v.annotations)) {
        for (const a of v.annotations as Array<Record<string, unknown>>) {
          const fragment = str(a?.fragment);
          const explanation = str(a?.explanation);
          if (fragment && explanation) parts.push(`"${fragment}" — ${explanation}`);
        }
      }
      text = parts.filter(Boolean).join("\n\n");
      break;
    }
    default:
      return null;
  }
  return text ? cap(text) : null;
}

export interface CueContextImageItem {
  url: string;
  caption?: string;
  /** Attribution line as the gallery shows it. */
  source?: string;
  author?: string;
  license?: string;
  pageUrl?: string;
  width?: number;
  height?: number;
}

/** The https images of one `image_gallery` value, capped, attribution kept.
 *  Anything without a usable https URL is dropped — cue images must be https. */
export function galleryImages(value: unknown): CueContextImageItem[] {
  const images = (value as ImageGalleryData | null)?.images;
  if (!Array.isArray(images)) return [];
  const out: CueContextImageItem[] = [];
  for (const img of images) {
    if (!img || typeof img.url !== "string" || !/^https:\/\//i.test(img.url)) continue;
    const item: CueContextImageItem = { url: img.url };
    for (const k of ["caption", "source", "author", "license", "pageUrl"] as const) {
      const v = img[k];
      if (typeof v === "string" && v.trim()) item[k] = v.trim();
    }
    if (typeof img.width === "number") item.width = img.width;
    if (typeof img.height === "number") item.height = img.height;
    out.push(item);
    if (out.length >= CONTEXT_IMAGE_CAP) break;
  }
  return out;
}

export interface CueContextLyrics {
  kind: "synced" | "plain";
  /** Synced only: one entry per sung line, `at` in seconds. */
  lines?: Array<{ at: number; text: string }>;
  /** Plain only. */
  text?: string;
  /** Set when the lines don't fit this track's length (`lyricsTimingNote`). */
  note?: string;
}

/** Lyrics shaped for the assistant: synced → timed lines (blank gap lines
 *  dropped — they mark instrumental stretches by their absence), plain → text. */
export function lyricsForContext(value: unknown): CueContextLyrics | null {
  const data = value as LyricsData | null;
  if (!data || typeof data.text !== "string" || !data.text.trim()) return null;
  if (data.kind === "synced") {
    const lines = parseLrc(data.text)
      .filter((l) => l.text.trim())
      .map((l) => ({ at: Math.round(l.time * 100) / 100, text: l.text.trim() }));
    if (lines.length > 0) return { kind: "synced", lines };
  }
  return { kind: "plain", text: data.text.trim() };
}

/** A warning when synced lyrics evidently belong to a different cut of the
 *  song: lines running past the track's end (an album version against a
 *  radio edit — the self-test's lyrics ran to 325s on a 294s track), or
 *  ending far short of it (a long live take). Same two-sided rule as the
 *  video subtitles' `syncedLyricsFitMedia`; null when they fit or nothing is
 *  known. Without it an assistant times cues to lines that will drift. */
export function lyricsTimingNote(lyrics: CueContextLyrics | null, durationSecs: number | null): string | null {
  if (!lyrics?.lines?.length || !durationSecs) return null;
  const last = lyrics.lines[lyrics.lines.length - 1].at;
  const past = lyrics.lines.filter((l) => l.at >= durationSecs).length;
  if (last > durationSecs + 10) {
    return `These synced lyrics run to ${Math.round(last)}s but the track is ${Math.round(durationSecs)}s long — they were timed to a different version, so line times may drift. ${past} line(s) fall after the end; cues there are rejected.`;
  }
  if (last < durationSecs * 0.6) {
    return `These synced lyrics end at ${Math.round(last)}s of a ${Math.round(durationSecs)}s track — probably timed to a shorter version, so line times may not match this one.`;
  }
  return null;
}

export interface CueContextProse {
  about: "song" | "artist" | "album";
  typeId: string;
  name: string;
  text: string;
}

export interface CueContextImages {
  about: "song" | "artist" | "album";
  typeId: string;
  name: string;
  images: CueContextImageItem[];
}

/** An info value that didn't arrive by the deadline: what it is, and the
 *  `get_entity_info` arguments that fetch it. */
export interface CueContextPending {
  about: "song" | "artist" | "album";
  typeId: string;
  name: string;
  fetch: { kind: "track" | "artist" | "album"; name?: string; title?: string; artistName?: string; typeId: string };
}

export interface CueContext {
  track: {
    title: string;
    artistName: string | null;
    albumTitle: string | null;
    albumArtistName: string | null;
    durationSecs: number | null;
    quality: string | null;
    isPlaying: boolean;
  };
  lyrics: CueContextLyrics | null;
  prose: CueContextProse[];
  /** Galleries from image providers — the only image URLs to use in cues
   *  besides ones the assistant is certain of. */
  images: CueContextImages[];
  tags: string[];
  existingSheet: CueSheetRow | null;
  guide: string;
  /** The clip (`mode: "clip"`) half of the format. */
  clipGuide: string;
  /** Kinds of sheet to offer the user, fitting ones first. */
  styles: CueStyleOffer[];
  /** How to use `styles`. */
  styleGuide: string;
  /** Values still on their way when the deadline passed — empty when
   *  everything arrived. */
  pending: CueContextPending[];
  /** Set with a non-empty `pending`: what to do about it. */
  pendingNote?: string;
}

export const CUE_PENDING_NOTE =
  "Some providers were still answering when this context was put together; `pending` lists what is missing. It keeps loading in the background: fetch what you need with get_entity_info (each entry's `fetch` is the arguments), or call get_cue_context again in a little while. If what is here is enough for the chosen style, write from it.";

interface GatherOpts {
  track: QueueTrack;
  /** The track is the one playing now — its live engine facts are its own. */
  isPlaying: boolean;
  invokeInfoFetch: InvokeInfoFetch;
  pluginNames?: Map<string, string>;
  /** Overrides `CUE_CONTEXT_DEADLINE_MS` (tests). */
  deadlineMs?: number;
}

interface EntityMaterial {
  prose: CueContextProse[];
  images: CueContextImages[];
  pending: CueContextPending[];
}

/** The `get_entity_info` arguments naming `entity`. */
function fetchArgs(entity: InfoEntity, typeId: string): CueContextPending["fetch"] {
  if (entity.kind === "artist") return { kind: "artist", name: entity.name, typeId };
  const kind = entity.kind === "album" ? "album" : "track";
  return { kind, title: entity.name, ...(entity.artistName ? { artistName: entity.artistName } : {}), typeId };
}

/** Every prose and gallery info value for one entity, through the provider
 *  chain, as far as it got by `deadline`. One type listing serves both. */
async function materialFor(
  about: CueContextProse["about"],
  entity: InfoEntity,
  opts: GatherOpts,
  deadline: Promise<void>,
): Promise<EntityMaterial> {
  let types: InfoTypeRow[];
  try {
    types = await invoke<InfoTypeRow[]>("info_get_types_for_entity", { entity: entity.kind });
  } catch (e) {
    console.error(`Failed to list ${entity.kind} info types for cue context:`, e);
    return NO_MATERIAL;
  }
  const wanted = types.filter(([, , displayKind]) =>
    CONTEXT_DISPLAY_KINDS.includes(displayKind as DisplayKind)
    || CONTEXT_IMAGE_DISPLAY_KINDS.includes(displayKind as DisplayKind));
  const results = await Promise.all(wanted.map(([typeId, name]) => settleBy((async () => {
    try {
      const out = await fetchInfoValue({
        typeId, entity, invokeInfoFetch: opts.invokeInfoFetch, pluginNames: opts.pluginNames,
      });
      if (out.status !== "ok") return null;
      if (CONTEXT_IMAGE_DISPLAY_KINDS.includes(out.displayKind as DisplayKind)) {
        const images = galleryImages(out.value);
        return images.length ? { images: { about, typeId, name: out.name, images } } : null;
      }
      const text = proseText(out.displayKind, out.value);
      return text ? { prose: { about, typeId, name: out.name, text } } : null;
    } catch (e) {
      console.error(`Failed to fetch ${typeId} for cue context:`, e);
      return null;
    }
  })(), deadline).then((r) => (r === TIMED_OUT
    ? { pending: { about, typeId, name, fetch: fetchArgs(entity, typeId) } }
    : r))));
  const material: EntityMaterial = { prose: [], images: [], pending: [] };
  for (const r of results) {
    if (!r) continue;
    if ("pending" in r) material.pending.push(r.pending);
    else if (r.prose) material.prose.push(r.prose);
    else if (r.images) material.images.push(r.images);
  }
  return material;
}

const NO_MATERIAL: EntityMaterial = { prose: [], images: [], pending: [] };

export async function gatherCueContext(opts: GatherOpts): Promise<CueContext> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, opts.deadlineMs ?? CUE_CONTEXT_DEADLINE_MS);
  });
  try {
    return await gatherBy(opts, deadline);
  } finally {
    clearTimeout(timer);
  }
}

async function gatherBy(opts: GatherOpts, deadline: Promise<void>): Promise<CueContext> {
  const { track } = opts;
  const title = track.title;
  const artistName = track.artist_name ?? null;
  const albumTitle = track.album_title ?? null;
  const albumArtistName = track.album_artist_name ?? artistName;

  const songBase = { kind: "track" as const, name: title, artistName: artistName ?? undefined, albumTitle: albumTitle ?? undefined };
  const songEntity: InfoEntity = { ...songBase, id: await resolveInfoEntityId(songBase), path: track.path ?? undefined, durationSecs: track.duration_secs ?? undefined };
  const artistEntity: InfoEntity | null = artistName
    ? { kind: "artist", name: artistName, id: await resolveInfoEntityId({ kind: "artist", name: artistName }) }
    : null;
  const albumEntity: InfoEntity | null = albumTitle
    ? {
      kind: "album", name: albumTitle, artistName: albumArtistName ?? undefined,
      id: await resolveInfoEntityId({ kind: "album", name: albumTitle, artistName: albumArtistName ?? undefined }),
    }
    : null;

  const lyricsP = settleBy(fetchInfoValue({
    typeId: "lyrics", entity: songEntity, invokeInfoFetch: opts.invokeInfoFetch, pluginNames: opts.pluginNames,
  })
    .then((out) => (out.status === "ok" ? lyricsForContext(out.value) : null))
    .catch((e) => { console.error("Failed to fetch lyrics for cue context:", e); return null; }), deadline);

  const tagsP = (async () => {
    if (!songEntity.id) return [];
    try {
      const rows = await invoke<Array<{ name: string }>>("get_tags_for_track", { trackId: songEntity.id });
      return rows.map((r) => r.name);
    } catch (e) {
      console.error("Failed to read tags for cue context:", e);
      return [];
    }
  })();

  const existingP = invoke<CueSheetRow | null>("cue_sheet_get", { title, artistName })
    .catch((e) => { console.error("Failed to read cue sheet for cue context:", e); return null; });

  // The local reads and the quality probe race the deadline too, falling
  // back to their empty answer — a hung probe must not hold the context.
  const orElse = <T,>(p: Promise<T>, fallback: T) =>
    settleBy(p, deadline).then((r) => (r === TIMED_OUT ? fallback : r));

  const [lyricsOut, song, artist, album, tags, quality, existingSheet] = await Promise.all([
    lyricsP,
    materialFor("song", songEntity, opts, deadline),
    artistEntity ? materialFor("artist", artistEntity, opts, deadline) : Promise.resolve(NO_MATERIAL),
    albumEntity ? materialFor("album", albumEntity, opts, deadline) : Promise.resolve(NO_MATERIAL),
    orElse(tagsP, [] as string[]),
    orElse(resolveTrackQuality(track, { playing: opts.isPlaying }), null),
    orElse(existingP, null),
  ]);

  const lyrics = lyricsOut === TIMED_OUT ? null : lyricsOut;
  const pending: CueContextPending[] = [
    ...(lyricsOut === TIMED_OUT
      ? [{ about: "song" as const, typeId: "lyrics", name: "Lyrics", fetch: fetchArgs(songEntity, "lyrics") }]
      : []),
    ...song.pending, ...artist.pending, ...album.pending,
  ];
  const lyricsNote = lyricsTimingNote(lyrics, track.duration_secs ?? null);
  const prose = [...song.prose, ...artist.prose, ...album.prose];
  const images = [...song.images, ...artist.images, ...album.images];
  return {
    track: {
      title,
      artistName,
      albumTitle,
      albumArtistName,
      durationSecs: track.duration_secs ?? null,
      quality,
      isPlaying: opts.isPlaying,
    },
    lyrics: lyricsNote && lyrics ? { ...lyrics, note: lyricsNote } : lyrics,
    prose,
    images,
    tags,
    existingSheet,
    guide: CUE_SHEET_GUIDE,
    clipGuide: CUE_CLIP_GUIDE,
    styles: cueStylesFor({ lyrics, prose, imageCount: images.reduce((n, g) => n + g.images.length, 0) }),
    styleGuide: CUE_STYLE_GUIDE,
    pending,
    ...(pending.length ? { pendingNote: CUE_PENDING_NOTE } : {}),
  };
}
