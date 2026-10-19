import type { Track } from "../types";
import { normalizeForMatch } from "./normalize";
import { resolveImageUrl } from "./resolveImageUrl";

export type ResolvedInfoEntity = { id?: number; imageSrc?: string };

export interface DetailResolveContext {
  /** The page's own track list, searched for a `track` entity. */
  tracks: Track[];
  /** Artist assumed for a track name that doesn't carry one (`title|||artist`). */
  defaultArtist?: string | null;
  /** The page's library artist, so an `artist` entity naming it links by id. */
  artist?: { id: number; name: string } | null;
  getArtistImage: (name: string) => string | null | undefined;
}

/** The `resolveEntity` an artist or album page hands `InformationSections`:
 *  links an info section's artist / track names to the library and to cached
 *  artist images. Names compare through `normalizeForMatch`, like every
 *  in-memory metadata match. */
export function resolveDetailEntity(
  kind: string,
  entityName: string,
  ctx: DetailResolveContext,
): ResolvedInfoEntity | undefined {
  if (kind === "artist") {
    const imgPath = ctx.getArtistImage(entityName);
    const imageSrc = imgPath ? resolveImageUrl(imgPath) : undefined;
    if (ctx.artist && normalizeForMatch(ctx.artist.name) === normalizeForMatch(entityName)) {
      return { id: ctx.artist.id, imageSrc };
    }
    return imageSrc ? { imageSrc } : undefined;
  }
  if (kind === "track") {
    const [trackName, trackArtistName] = entityName.includes("|||")
      ? entityName.split("|||")
      : [entityName, ctx.defaultArtist];
    const title = normalizeForMatch(trackName);
    const artist = trackArtistName ? normalizeForMatch(trackArtistName) : null;
    const match = ctx.tracks.find(t =>
      normalizeForMatch(t.title) === title &&
      (!artist || normalizeForMatch(t.artist_name ?? "") === artist),
    );
    if (match) return { id: match.id ?? undefined };
  }
  return undefined;
}
