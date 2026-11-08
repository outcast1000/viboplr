// Pictures of a track, its artist and its album, from the plugins that offer
// them. One definition of "an info type that carries pictures", read by two
// consumers: the cue-sheet context an assistant writes from (`cueContext.ts`)
// and the Now Playing "Photos" visualizer (`useNowPlayingPhotos`). A plugin
// "registers for track images" by answering such a type — an `image_gallery`
// for the song, artist or album, or any type it flags `contextImages: true`
// whose value carries the same `images` array (Getty's `plugin_view` tab).
// Values come through the shared provider chain + cache, so photos fetched for
// Now Playing are free on the detail page and in a cue context, and back.

import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";
import type { DisplayKind, ImageGalleryData, InfoEntity } from "../types/informationTypes";
import { fetchInfoValue, resolveInfoEntityId, type InvokeInfoFetch, type InfoTypeRow } from "./infoFetchChain";

/** Display kinds whose values are pictures of an entity. An assistant may only
 *  use image URLs it can trust, so a provider's gallery is the safe source. */
export const CONTEXT_IMAGE_DISPLAY_KINDS: DisplayKind[] = ["image_gallery"];

/** Info types of another display kind whose value also carries an `images`
 *  gallery — declared by the plugin with `contextImages: true` (a `plugin_view`
 *  tab of agency photos). Opt-in by manifest, never by sniffing values: the
 *  gather would otherwise have to fetch every interactive tab (Community's)
 *  just to find out it has no pictures. */
export function contextImageTypeIds(
  plugins: ReadonlyArray<{ manifest: { contributes?: { informationTypes?: Array<{ id: string; contextImages?: boolean }> } } }>,
): Set<string> {
  const ids = new Set<string>();
  for (const p of plugins) {
    for (const t of p.manifest.contributes?.informationTypes ?? []) {
      if (t.contextImages === true) ids.add(t.id);
    }
  }
  return ids;
}

/** Does this info type carry pictures? */
export function isGalleryType(
  typeId: string,
  displayKind: string,
  imageTypeIds?: ReadonlySet<string>,
): boolean {
  return CONTEXT_IMAGE_DISPLAY_KINDS.includes(displayKind as DisplayKind) || !!imageTypeIds?.has(typeId);
}

/** Per-gallery cap — enough to choose from, small enough to keep a cue
 *  context one tool result. */
export const CONTEXT_IMAGE_CAP = 12;

export interface GalleryImage {
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

/** The https images of one gallery value, capped, attribution kept. Anything
 *  without a usable https URL is dropped — cue images must be https, and the
 *  Photos slideshow loads them straight into the webview. */
export function galleryImages(value: unknown): GalleryImage[] {
  const images = (value as ImageGalleryData | null)?.images;
  if (!Array.isArray(images)) return [];
  const out: GalleryImage[] = [];
  for (const img of images) {
    if (!img || typeof img.url !== "string" || !/^https:\/\//i.test(img.url)) continue;
    const item: GalleryImage = { url: img.url };
    for (const k of ["caption", "source", "author", "license"] as const) {
      const v = img[k];
      if (typeof v === "string" && v.trim()) item[k] = v.trim();
    }
    // A page link is opened in the system browser (the Photos credit) or
    // handed to an assistant, so only a web page — never file:// or an app
    // scheme a plugin happened to return.
    if (typeof img.pageUrl === "string" && /^https?:\/\//i.test(img.pageUrl.trim())) {
      item.pageUrl = img.pageUrl.trim();
    }
    if (typeof img.width === "number") item.width = img.width;
    if (typeof img.height === "number") item.height = img.height;
    out.push(item);
    if (out.length >= CONTEXT_IMAGE_CAP) break;
  }
  return out;
}

export type GalleryAbout = "song" | "artist" | "album";

export interface TrackGallery {
  about: GalleryAbout;
  typeId: string;
  /** The info type's display name. */
  name: string;
  images: GalleryImage[];
}

export interface TrackInfoEntities {
  song: InfoEntity;
  artist: InfoEntity | null;
  album: InfoEntity | null;
}

/** The three info entities a track's material hangs off. Album art and album
 *  values are keyed by the album's own artist (ALBUMARTIST). */
export async function trackInfoEntities(track: QueueTrack): Promise<TrackInfoEntities> {
  const artistName = track.artist_name ?? null;
  const albumTitle = track.album_title ?? null;
  const albumArtistName = track.album_artist_name ?? artistName;
  const songBase = {
    kind: "track" as const, name: track.title,
    artistName: artistName ?? undefined, albumTitle: albumTitle ?? undefined,
  };
  const artistBase = artistName ? { kind: "artist" as const, name: artistName } : null;
  const albumBase = albumTitle
    ? { kind: "album" as const, name: albumTitle, artistName: albumArtistName ?? undefined }
    : null;
  // Three independent lookups, one round trip each — asked together.
  const [songId, artistId, albumId] = await Promise.all([
    resolveInfoEntityId(songBase),
    artistBase ? resolveInfoEntityId(artistBase) : null,
    albumBase ? resolveInfoEntityId(albumBase) : null,
  ]);
  const song: InfoEntity = {
    ...songBase, id: songId,
    path: track.path ?? undefined, durationSecs: track.duration_secs ?? undefined,
  };
  const artist: InfoEntity | null = artistBase && artistId !== null ? { ...artistBase, id: artistId } : null;
  const album: InfoEntity | null = albumBase && albumId !== null ? { ...albumBase, id: albumId } : null;
  return { song, artist, album };
}

/** The info types one entity has that pass `want`, one row per type (the
 *  listing has a row per provider; the chain walks the providers itself).
 *  `null` when the listing itself failed — logged here, with `purpose`. The
 *  one listing both gathers use (Photos and the cue context), so what counts
 *  as "this entity's types" can't drift between them. */
export async function entityTypesWanted(
  entity: InfoEntity,
  want: (typeId: string, displayKind: string) => boolean,
  purpose: string,
): Promise<InfoTypeRow[] | null> {
  let types: InfoTypeRow[];
  try {
    types = await invoke<InfoTypeRow[]>("info_get_types_for_entity", { entity: entity.kind });
  } catch (e) {
    console.error(`Failed to list ${entity.kind} info types for ${purpose}:`, e);
    return null;
  }
  const seen = new Set<string>();
  return types.filter(([typeId, , displayKind]) => {
    if (seen.has(typeId) || !want(typeId, displayKind)) return false;
    seen.add(typeId);
    return true;
  });
}

interface GatherGalleriesOpts {
  track: QueueTrack;
  invokeInfoFetch: InvokeInfoFetch;
  pluginNames?: Map<string, string>;
  /** `contextImageTypeIds` of the active plugins. */
  imageTypeIds?: ReadonlySet<string>;
  /** Called once per gallery that came back with pictures, as each lands —
   *  one slow source (a scraped agency page) must not hold back the rest. */
  onGallery: (gallery: TrackGallery) => void;
  /** Checked before each fetch and each report: the caller moved on. */
  isCancelled?: () => boolean;
}

/** Every gallery for the track, its artist and its album. Resolves when all
 *  have settled; results arrive through `onGallery`. */
export async function gatherTrackGalleries(opts: GatherGalleriesOpts): Promise<void> {
  const { song, artist, album } = await trackInfoEntities(opts.track);
  const targets: Array<[GalleryAbout, InfoEntity]> = [["song", song]];
  if (artist) targets.push(["artist", artist]);
  if (album) targets.push(["album", album]);
  await Promise.all(targets.map(async ([about, entity]) => {
    if (opts.isCancelled?.()) return;
    const wanted = await entityTypesWanted(
      entity, (typeId, displayKind) => isGalleryType(typeId, displayKind, opts.imageTypeIds), "photos",
    );
    if (!wanted) return;
    await Promise.all(wanted.map(async ([typeId]) => {
      if (opts.isCancelled?.()) return;
      try {
        const out = await fetchInfoValue({
          typeId, entity, invokeInfoFetch: opts.invokeInfoFetch, pluginNames: opts.pluginNames,
        });
        if (out.status !== "ok" || opts.isCancelled?.()) return;
        const images = galleryImages(out.value);
        if (images.length) opts.onGallery({ about, typeId, name: out.name, images });
      } catch (e) {
        console.error(`Failed to fetch ${typeId} photos:`, e);
      }
    }));
  }));
}

/** One credit line for a picture: who took it and where it's from, without
 *  saying the same name twice (Commons already puts the author in `source`). */
export function galleryImageCredit(img: GalleryImage): string | null {
  const { author, source } = img;
  if (author && source) return source.includes(author) ? source : `${author} · ${source}`;
  return author ?? source ?? null;
}
