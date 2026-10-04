// The material an assistant writes a cue sheet from (GET /v1/cues/context):
// the track's identity and quality, its lyrics (synced lines carry their
// timestamps — the clock every cue is placed on), every prose info value for
// the song / artist / album (bio, review, song story, lyric annotations), its
// library tags, any sheet already saved, and the format guide. Everything
// comes through the same provider chain + cache the detail pages use, so a
// value fetched here is free on the next page visit and vice versa.

import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";
import type { DisplayKind, InfoEntity, LyricsData } from "../types/informationTypes";
import { fetchInfoValue, resolveInfoEntityId, type InvokeInfoFetch, type InfoTypeRow } from "./infoFetchChain";
import { parseLrc } from "./lyrics";
import { resolveTrackQuality } from "../hooks/useNowPlayingInfo";
import { CUE_CLIP_GUIDE, CUE_SHEET_GUIDE, type CueSheetRow } from "./cueSheet";

/** Display kinds that carry readable prose about an entity. A superset of the
 *  About panel's (`ABOUT_DISPLAY_KINDS`): lyric annotations are noise on a
 *  lean-back panel but exactly what a "what does this line mean" cue needs. */
export const CONTEXT_DISPLAY_KINDS: DisplayKind[] = ["rich_text", "html", "annotated_text", "annotations"];

/** Per-entry cap. A full Last.fm wiki can run to tens of KB; the assistant
 *  needs the substance, and the whole context should fit comfortably in one
 *  tool result. */
export const PROSE_CHAR_CAP = 6000;

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
  tags: string[];
  existingSheet: CueSheetRow | null;
  guide: string;
  /** The clip (`mode: "clip"`) half of the format. */
  clipGuide: string;
}

interface GatherOpts {
  track: QueueTrack;
  /** The track is the one playing now — its live engine facts are its own. */
  isPlaying: boolean;
  invokeInfoFetch: InvokeInfoFetch;
  pluginNames?: Map<string, string>;
}

async function proseFor(
  about: CueContextProse["about"],
  entity: InfoEntity,
  opts: GatherOpts,
): Promise<CueContextProse[]> {
  let types: InfoTypeRow[];
  try {
    types = await invoke<InfoTypeRow[]>("info_get_types_for_entity", { entity: entity.kind });
  } catch (e) {
    console.error(`Failed to list ${entity.kind} info types for cue context:`, e);
    return [];
  }
  const wanted = types.filter(([, , displayKind]) => CONTEXT_DISPLAY_KINDS.includes(displayKind as DisplayKind));
  const results = await Promise.all(wanted.map(async ([typeId]) => {
    try {
      const out = await fetchInfoValue({
        typeId, entity, invokeInfoFetch: opts.invokeInfoFetch, pluginNames: opts.pluginNames,
      });
      if (out.status !== "ok") return null;
      const text = proseText(out.displayKind, out.value);
      return text ? { about, typeId, name: out.name, text } : null;
    } catch (e) {
      console.error(`Failed to fetch ${typeId} for cue context:`, e);
      return null;
    }
  }));
  return results.filter((r): r is CueContextProse => r !== null);
}

export async function gatherCueContext(opts: GatherOpts): Promise<CueContext> {
  const { track } = opts;
  const title = track.title;
  const artistName = track.artist_name ?? null;
  const albumTitle = track.album_title ?? null;
  const albumArtistName = track.album_artist_name ?? artistName;

  const songBase = { kind: "track" as const, name: title, artistName: artistName ?? undefined, albumTitle: albumTitle ?? undefined };
  const songEntity: InfoEntity = { ...songBase, id: await resolveInfoEntityId(songBase), path: track.path ?? undefined };
  const artistEntity: InfoEntity | null = artistName
    ? { kind: "artist", name: artistName, id: await resolveInfoEntityId({ kind: "artist", name: artistName }) }
    : null;
  const albumEntity: InfoEntity | null = albumTitle
    ? {
      kind: "album", name: albumTitle, artistName: albumArtistName ?? undefined,
      id: await resolveInfoEntityId({ kind: "album", name: albumTitle, artistName: albumArtistName ?? undefined }),
    }
    : null;

  const lyricsP = fetchInfoValue({
    typeId: "lyrics", entity: songEntity, invokeInfoFetch: opts.invokeInfoFetch, pluginNames: opts.pluginNames,
  })
    .then((out) => (out.status === "ok" ? lyricsForContext(out.value) : null))
    .catch((e) => { console.error("Failed to fetch lyrics for cue context:", e); return null; });

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

  const [lyrics, songProse, artistProse, albumProse, tags, quality, existingSheet] = await Promise.all([
    lyricsP,
    proseFor("song", songEntity, opts),
    artistEntity ? proseFor("artist", artistEntity, opts) : Promise.resolve([]),
    albumEntity ? proseFor("album", albumEntity, opts) : Promise.resolve([]),
    tagsP,
    resolveTrackQuality(track, { playing: opts.isPlaying }),
    existingP,
  ]);

  const lyricsNote = lyricsTimingNote(lyrics, track.duration_secs ?? null);
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
    prose: [...songProse, ...artistProse, ...albumProse],
    tags,
    existingSheet,
    guide: CUE_SHEET_GUIDE,
    clipGuide: CUE_CLIP_GUIDE,
  };
}
