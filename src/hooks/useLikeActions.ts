import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Artist, Album, Tag, QueueTrack } from "../types";
import type { PluginEventName } from "../types/plugin";
import { trackLikePayload, entityLikePayload, nextTriState, trackLikeChange, entityLikeChange } from "../likeKeys";
import { normalizeForMatch } from "../utils/normalize";
import { trackLikeId } from "../utils/likeReconcile";
import type { Notify } from "./useToasts";
import type { TrackLikeStore } from "../utils/trackLikeStore";

// Artist / album / tag likes are mirrored into these lists. Track likes are
// not: they live in the track-like store, whose listeners update every copy.
interface LibraryDeps {
  artists: Artist[];
  albums: Album[];
  tags: Tag[];
  setArtists: React.Dispatch<React.SetStateAction<Artist[]>>;
  setAlbums: React.Dispatch<React.SetStateAction<Album[]>>;
  setTags: React.Dispatch<React.SetStateAction<Tag[]>>;
}

interface PluginsDeps {
  dispatchEvent: (event: PluginEventName, ...args: unknown[]) => void;
}

interface UseLikeActionsDeps {
  library: LibraryDeps;
  plugins: PluginsDeps;
  // Surface a failed like/dislike write to the user (toast). Wired from
  // useToasts().notify in App.tsx so a rejected set_entity_like_state is never
  // silent — see conventions "User Feedback for Significant Operations".
  notify: Notify;
  // The track-like store: the one answer to "is this song liked?". A track
  // like reads its current state here and writes here first (optimistic,
  // reverted on failure); the store's listeners move every heart and copy.
  likeStore: TrackLikeStore;
}

// A queue/now-playing entry is the same song as `track` when its in-memory key
// matches, OR — for copies that came from a different surface (external source,
// restored playlist, a duplicate add) and so carry a different key — when the
// metadata identity (`trackLikeId`, the backend's like key) matches. Used for
// song identity (play continuation, the control API), no longer for likes:
// a like lives once in the track-like store.
export function sameSong(a: QueueTrack, b: QueueTrack): boolean {
  if (a.key === b.key) return true;
  return trackLikeId(a.title, a.artist_name) === trackLikeId(b.title, b.artist_name);
}

export function useLikeActions(deps: UseLikeActionsDeps) {
  const { library, plugins, notify, likeStore } = deps;

  // In-flight guard, keyed by the song's metadata identity (the dimension the
  // durable like key uses) so a rapid second click — on the same now-playing
  // button OR on another same-song copy — is ignored until the prior write
  // resolves. This is the functional fix for the double-click toggle race: two
  // clicks reading the same (pre-update) liked value can no longer both advance
  // the cycle and persist a rating the user never chose.
  const inFlightRef = useRef<Set<string>>(new Set());
  const likeIdentity = (track: Track | QueueTrack) => trackLikeId(track.title, track.artist_name);
  // The song's current state: the store's answer, the copy's own `liked` until
  // the store has loaded (or when there is none). A copy can be stale — a
  // plugin row hardcodes 0 — so the store wins whenever it can answer.
  const currentLike = (track: Track | QueueTrack) => likeStore.lookupKey(likeIdentity(track), track.liked);

  /** Set a track's rating to an absolute tri-state value. The toggle handlers
   *  route through here (with `nextTriState`) so the two paths can't drift;
   *  the control API calls it directly for idempotent set semantics. The one
   *  plugin event is `like:changed`, sent from what the store says changed —
   *  never from which button was pressed. Returns whether the write succeeded. */
  async function setTrackRating(track: Track | QueueTrack, likeState: number): Promise<boolean> {
    const id = likeIdentity(track);
    if (inFlightRef.current.has(id)) return false;
    const prevLiked = currentLike(track);
    inFlightRef.current.add(id);
    // Optimistic: the store moves every heart, and its copy listener
    // (useTrackLikeCopySync) every copy of the song, library or not.
    likeStore.set(id, likeState);
    try {
      const stored = await invoke<number>("set_entity_like_state", {
        kind: "track",
        entity: trackLikePayload(track),
        likeState,
      });
      // Only after the write succeeds — never optimistically.
      // `previous` is the store's answer, not this copy's (which can be stale);
      // an idempotent set (control API) that changed nothing is not a change.
      const previous = typeof stored === "number" ? stored : prevLiked ?? 0;
      if (likeState !== previous) {
        plugins.dispatchEvent("like:changed", trackLikeChange(track, likeState, previous));
      }
      return true;
    } catch (e) {
      console.error("Failed to set track rating:", e);
      // Revert the optimistic write and surface the failure.
      likeStore.set(id, prevLiked);
      notify(`Couldn't save like for "${track.title}" — please retry`, { kind: "error" });
      return false;
    } finally {
      inFlightRef.current.delete(id);
    }
  }

  async function applyTrackRating(track: Track | QueueTrack, action: "like" | "dislike") {
    await setTrackRating(track, nextTriState(currentLike(track), action));
  }

  async function handleToggleLike(track: Track | QueueTrack) {
    await applyTrackRating(track, "like");
  }

  async function handleToggleDislike(track: Track | QueueTrack) {
    await applyTrackRating(track, "dislike");
  }

  /** One optimistic write for artist/album/tag likes: mirror, persist, revert
   *  on failure. The six toggle handlers and the name-based set-state entry
   *  points (control API) all route through here. `noun` keeps the historical
   *  failure copy ("like" for like actions, "rating" otherwise). */
  async function writeEntityLike(
    kind: "artist" | "album" | "tag",
    entity: ReturnType<typeof entityLikePayload>,
    likeState: number,
    prevLiked: number,
    mirror: (liked: number) => void,
    label: string,
    noun: "like" | "rating",
  ): Promise<boolean> {
    mirror(likeState);
    try {
      const stored = await invoke<number>("set_entity_like_state", { kind, entity, likeState });
      // Same rule as setTrackRating: the store says what was replaced.
      const previous = typeof stored === "number" ? stored : prevLiked;
      if (likeState !== previous) {
        plugins.dispatchEvent("like:changed", entityLikeChange(kind, entity, likeState, previous));
      }
      return true;
    } catch (e) {
      console.error(`Failed to set ${kind} like state:`, e);
      mirror(prevLiked);
      notify(`Couldn't save ${noun} for "${label}" — please retry`, { kind: "error" });
      return false;
    }
  }

  const mirrorArtist = (artistId: number) => (liked: number) =>
    library.setArtists(prev => prev.map(a => a.id === artistId ? { ...a, liked } : a));
  const mirrorAlbum = (albumId: number) => (liked: number) =>
    library.setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked } : a));
  const mirrorTag = (tagId: number) => (liked: number) =>
    library.setTags(prev => prev.map(t => t.id === tagId ? { ...t, liked } : t));

  async function applyArtistRating(artistId: number, action: "like" | "dislike") {
    const artist = library.artists.find(a => a.id === artistId);
    if (!artist) return;
    await writeEntityLike(
      "artist", entityLikePayload(artist.name), nextTriState(artist.liked, action),
      artist.liked, mirrorArtist(artistId), artist.name, action === "like" ? "like" : "rating",
    );
  }

  async function applyAlbumRating(albumId: number, action: "like" | "dislike") {
    const album = library.albums.find(a => a.id === albumId);
    if (!album) return;
    await writeEntityLike(
      "album", entityLikePayload(album.title, album.artist_name), nextTriState(album.liked, action),
      album.liked, mirrorAlbum(albumId), album.title, action === "like" ? "like" : "rating",
    );
  }

  async function applyTagRating(tagId: number, action: "like" | "dislike") {
    const tag = library.tags.find(t => t.id === tagId);
    if (!tag) return;
    await writeEntityLike(
      "tag", entityLikePayload(tag.name), nextTriState(tag.liked, action),
      tag.liked, mirrorTag(tagId), tag.name, action === "like" ? "like" : "rating",
    );
  }

  const handleToggleArtistLike = (artistId: number) => applyArtistRating(artistId, "like");
  const handleToggleArtistDislike = (artistId: number) => applyArtistRating(artistId, "dislike");
  const handleToggleAlbumLike = (albumId: number) => applyAlbumRating(albumId, "like");
  const handleToggleAlbumDislike = (albumId: number) => applyAlbumRating(albumId, "dislike");
  const handleToggleTagLike = (tagId: number) => applyTagRating(tagId, "like");
  const handleToggleTagDislike = (tagId: number) => applyTagRating(tagId, "dislike");

  // --- Name-addressed set-state (control API) ---
  // The durable entity_likes store is metadata-keyed, so the write always
  // succeeds even when the entity isn't in loaded library state — `mirrored`
  // reports whether the in-memory lists could be updated optimistically (a
  // false means the UI catches up on the next list load).

  async function setArtistLike(name: string, likeState: number): Promise<{ ok: boolean; mirrored: boolean }> {
    const n = normalizeForMatch(name);
    const artist = library.artists.find(a => normalizeForMatch(a.name) === n) ?? null;
    const canonical = artist?.name ?? name;
    const ok = await writeEntityLike(
      "artist", entityLikePayload(canonical), likeState, artist?.liked ?? 0,
      artist ? mirrorArtist(artist.id) : () => {}, canonical, "rating",
    );
    return { ok, mirrored: artist !== null };
  }

  async function setAlbumLike(
    title: string,
    artistName: string | undefined,
    likeState: number,
  ): Promise<{ ok: boolean; mirrored: boolean }> {
    const t = normalizeForMatch(title);
    const a = artistName ? normalizeForMatch(artistName) : null;
    const album = library.albums.find(al =>
      normalizeForMatch(al.title) === t &&
      (a === null || normalizeForMatch(al.artist_name ?? "") === a)) ?? null;
    const ok = await writeEntityLike(
      "album",
      entityLikePayload(album?.title ?? title, album?.artist_name ?? artistName),
      likeState, album?.liked ?? 0,
      album ? mirrorAlbum(album.id) : () => {}, album?.title ?? title, "rating",
    );
    return { ok, mirrored: album !== null };
  }

  async function setTagLike(name: string, likeState: number): Promise<{ ok: boolean; mirrored: boolean }> {
    const n = normalizeForMatch(name);
    const tag = library.tags.find(t => normalizeForMatch(t.name) === n) ?? null;
    const canonical = tag?.name ?? name;
    const ok = await writeEntityLike(
      "tag", entityLikePayload(canonical), likeState, tag?.liked ?? 0,
      tag ? mirrorTag(tag.id) : () => {}, canonical, "rating",
    );
    return { ok, mirrored: tag !== null };
  }

  return {
    handleToggleLike,
    handleToggleDislike,
    handleToggleArtistLike,
    handleToggleArtistDislike,
    handleToggleAlbumLike,
    handleToggleAlbumDislike,
    handleToggleTagLike,
    handleToggleTagDislike,
    setTrackRating,
    setArtistLike,
    setAlbumLike,
    setTagLike,
  };
}
