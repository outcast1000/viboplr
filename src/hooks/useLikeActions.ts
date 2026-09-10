import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Artist, Album, Tag, QueueTrack } from "../types";
import type { PluginEventName } from "../types/plugin";
import { emitTrackPatch } from "../trackEvents";
import { trackLikePayload, entityLikePayload, nextTriState } from "../likeKeys";
import { normalizeForMatch } from "../utils/normalize";
import { trackLikeId } from "../utils/likeReconcile";

interface LibraryDeps {
  tracks: Track[];
  artists: Artist[];
  albums: Album[];
  tags: Tag[];
  setTracks: React.Dispatch<React.SetStateAction<Track[]>>;
  setArtists: React.Dispatch<React.SetStateAction<Artist[]>>;
  setAlbums: React.Dispatch<React.SetStateAction<Album[]>>;
  setTags: React.Dispatch<React.SetStateAction<Tag[]>>;
}

interface PlaybackDeps {
  currentTrack: QueueTrack | null;
  setCurrentTrack: React.Dispatch<React.SetStateAction<QueueTrack | null>>;
}

interface QueueDeps {
  setQueue: React.Dispatch<React.SetStateAction<QueueTrack[]>>;
}

interface PluginsDeps {
  dispatchEvent: (event: PluginEventName, ...args: unknown[]) => void;
}

interface UseLikeActionsDeps {
  library: LibraryDeps;
  playback: PlaybackDeps;
  queueHook: QueueDeps;
  plugins: PluginsDeps;
  // Surface a failed like/dislike write to the user (toast). Wired from
  // useToasts().notify in App.tsx so a rejected set_entity_like_state is never
  // silent — see conventions "User Feedback for Significant Operations".
  notify: (message: string) => void;
}

// The metadata fallbacks below all compare `trackLikeId` (utils/likeReconcile)
// — the SAME normalized title+artist identity the durable entity_likes key is
// built from. One definition, deliberately: the invariant "optimistic matching
// agrees with the key the backend wrote" was maintained in three hand-rolled
// copies of the normalize-and-compare, and any drift would silently leave the
// optimistic heart pointing at rows the durable store doesn't. Normalization
// is diacritic-insensitive so a "Jóga"/"Joga" pair reads as one song, exactly
// as the backend treats it.

// Which library rows a like on `track` should optimistically patch.
//
// Prefer the entry's cached `libraryId` and match the row's **own id**. Do NOT
// match on `key`: keys used to encode the id (`lib:N`) so comparing them
// happened to work, but a queue key is re-minted as `q:N` whenever it would
// collide and every restored entry gets a fresh one — so an entry can carry
// `libraryId: 42` alongside a key that names nothing. Comparing keys then
// matched no row *and*, because the id was non-null, skipped the metadata
// fallback: liking a restored track or a second copy of one left the library
// list's heart stale.
//
// With no cached id (a plugin search result, a metadata-only entry) fall back
// to the metadata identity, which is also how a `subsonic://` or plugin-scheme
// copy finds its local twin.
export function likeTargetsRow(
  row: { id: number | null; title: string; artist_name: string | null },
  track: QueueTrack,
): boolean {
  const directId = track.libraryId ?? null;
  if (directId != null) return row.id === directId;
  return trackLikeId(row.title, row.artist_name) === trackLikeId(track.title, track.artist_name);
}

// A queue/now-playing entry is the same song as `track` when its in-memory key
// matches, OR — for copies that came from a different surface (external source,
// restored playlist, a duplicate add) and so carry a different key — when the
// metadata identity matches. Without the fallback, liking a song
// from one surface would leave a same-song copy elsewhere in the queue stale.
export function sameSong(a: QueueTrack, b: QueueTrack): boolean {
  if (a.key === b.key) return true;
  return trackLikeId(a.title, a.artist_name) === trackLikeId(b.title, b.artist_name);
}

export function useLikeActions(deps: UseLikeActionsDeps) {
  const { library, playback, queueHook, plugins, notify } = deps;

  // In-flight guard, keyed by the song's metadata identity (the dimension the
  // durable like key uses) so a rapid second click — on the same now-playing
  // button OR on another same-song copy — is ignored until the prior write
  // resolves. This is the functional fix for the double-click toggle race: two
  // clicks reading the same (pre-update) liked value can no longer both advance
  // the cycle and persist a rating the user never chose.
  const inFlightRef = useRef<Set<string>>(new Set());
  const likeIdentity = (track: Track | QueueTrack) => trackLikeId(track.title, track.artist_name);

  // Apply a track's liked value across every in-memory mirror: library list
  // (likeTargetsRow's rule), currentTrack, and the queue (sameSong's rule).
  // Used both for the optimistic update and to revert it on failure. The
  // clicked track's identity is normalized ONCE here and compared per row —
  // the exported predicates re-derive it per call, which inside a setTracks
  // map would cost 2×N normalizations per like click.
  //
  // Accepts both track shapes because both surfaces click hearts: a library
  // list hands a `Track` (row handle = `id`, no render key), a queue/playback
  // surface hands a `QueueTrack` (cached `libraryId` + `key` fast path).
  function mirrorTrackLike(track: Track | QueueTrack, likedValue: number) {
    const directId = "id" in track ? track.id : track.libraryId ?? null;
    const trackKey = "key" in track ? track.key : null;
    const ident = trackLikeId(track.title, track.artist_name);
    const sameIdent = (t: { title: string; artist_name: string | null }) =>
      trackLikeId(t.title, t.artist_name) === ident;
    // = likeTargetsRow(t, track), with `ident` hoisted.
    library.setTracks(prev => prev.map(t =>
      (directId != null ? t.id === directId : sameIdent(t)) ? { ...t, liked: likedValue } : t));
    if (directId != null) emitTrackPatch(directId, { liked: likedValue });
    // = sameSong(t, track), with `ident` hoisted.
    if (playback.currentTrack && (playback.currentTrack.key === trackKey || sameIdent(playback.currentTrack))) {
      playback.setCurrentTrack(prev => prev ? { ...prev, liked: likedValue } : prev);
    }
    queueHook.setQueue(prev => prev.map(t =>
      (t.key === trackKey || sameIdent(t)) ? { ...t, liked: likedValue } : t));
  }

  /** Set a track's rating to an absolute tri-state value. The toggle handlers
   *  route through here (with `nextTriState`) so the two paths can't drift;
   *  the control API calls it directly for idempotent set semantics.
   *  `source` decides the plugin event: the like button dispatches on both
   *  transitions (like AND un-like — today's behavior), the dislike button
   *  never does, and an absolute set dispatches only when the new state is a
   *  like. Returns whether the write succeeded. */
  async function setTrackRating(
    track: Track | QueueTrack,
    likeState: number,
    source: "like" | "dislike" | "set" = "set",
  ): Promise<boolean> {
    const id = likeIdentity(track);
    if (inFlightRef.current.has(id)) return false;
    const prevLiked = track.liked;
    inFlightRef.current.add(id);
    // Optimistic: reflect the new state immediately so the UI is responsive.
    mirrorTrackLike(track, likeState);
    try {
      await invoke("set_entity_like_state", {
        kind: "track",
        entity: trackLikePayload(track),
        likeState,
      });
      // Only after the write succeeds — never optimistically.
      const dispatch = source === "like" || (source === "set" && likeState === 1);
      if (dispatch) plugins.dispatchEvent("track:liked", track, likeState === 1);
      return true;
    } catch (e) {
      console.error("Failed to set track rating:", e);
      // Revert the optimistic mirror to the prior value and surface the failure.
      mirrorTrackLike(track, prevLiked);
      notify(`Couldn't save like for "${track.title}" — please retry`);
      return false;
    } finally {
      inFlightRef.current.delete(id);
    }
  }

  async function applyTrackRating(track: Track | QueueTrack, action: "like" | "dislike") {
    await setTrackRating(track, nextTriState(track.liked, action), action);
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
      await invoke("set_entity_like_state", { kind, entity, likeState });
      return true;
    } catch (e) {
      console.error(`Failed to set ${kind} like state:`, e);
      mirror(prevLiked);
      notify(`Couldn't save ${noun} for "${label}" — please retry`);
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
