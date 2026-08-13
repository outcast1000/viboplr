import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Artist, Album, Tag, QueueTrack } from "../types";
import type { PluginEventName } from "../types/plugin";
import { parseLibraryId } from "../queueEntry";
import { emitTrackPatch } from "../trackEvents";
import { trackLikePayload, entityLikePayload, nextTriState } from "../likeKeys";
import { normalizeForMatch } from "../utils/normalize";

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

// A queue/now-playing entry is the same song as `track` when its in-memory key
// matches, OR — for copies that came from a different surface (external source,
// restored playlist, a duplicate add) and so carry a different `ext:N`/`lib:N`
// key — when title + artist match. Without the metadata fallback, liking a song
// from one surface would leave a same-song copy elsewhere in the queue stale.
// Matching is diacritic-insensitive (normalizeForMatch) so it agrees with the
// durable entity_likes key the write lands under — an exact comparison left a
// "Jóga"/"Joga" pair looking like different songs to the optimistic patch
// while the backend treated them as one.
export function sameSong(a: QueueTrack, b: QueueTrack): boolean {
  if (a.key === b.key) return true;
  return (
    normalizeForMatch(a.title) === normalizeForMatch(b.title) &&
    normalizeForMatch(a.artist_name ?? "") === normalizeForMatch(b.artist_name ?? "")
  );
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
  const likeIdentity = (track: QueueTrack) =>
    `${normalizeForMatch(track.title ?? "")}:${normalizeForMatch(track.artist_name ?? "")}`;

  // Apply a track's liked value across every in-memory mirror: library list
  // (by key, else best-effort by metadata for external tracks), currentTrack,
  // and the queue (via sameSong). Used both for the optimistic update and to
  // revert it on failure.
  function mirrorTrackLike(track: QueueTrack, likedValue: number) {
    const directId = parseLibraryId(track.key);
    if (directId != null) {
      library.setTracks(prev => prev.map(t => t.key === track.key ? { ...t, liked: likedValue } : t));
      emitTrackPatch(directId, { liked: likedValue });
    } else {
      library.setTracks(prev => prev.map(t =>
        t.title === track.title && (t.artist_name ?? null) === (track.artist_name ?? null)
          ? { ...t, liked: likedValue } : t));
    }
    if (playback.currentTrack && sameSong(playback.currentTrack, track)) {
      playback.setCurrentTrack(prev => prev ? { ...prev, liked: likedValue } : prev);
    }
    queueHook.setQueue(prev => prev.map(t => sameSong(t, track) ? { ...t, liked: likedValue } : t));
  }

  async function applyTrackRating(track: QueueTrack, action: "like" | "dislike") {
    const id = likeIdentity(track);
    if (inFlightRef.current.has(id)) return;
    const prevLiked = track.liked;
    const newLiked = nextTriState(prevLiked, action);
    inFlightRef.current.add(id);
    // Optimistic: reflect the new state immediately so the UI is responsive.
    mirrorTrackLike(track, newLiked);
    try {
      await invoke("set_entity_like_state", {
        kind: "track",
        entity: trackLikePayload(track),
        likeState: newLiked,
      });
      // Only "like" dispatches the plugin event (dislike never has), and only
      // after the write succeeds — never optimistically.
      if (action === "like") plugins.dispatchEvent("track:liked", track, newLiked === 1);
    } catch (e) {
      console.error(`Failed to toggle ${action}:`, e);
      // Revert the optimistic mirror to the prior value and surface the failure.
      mirrorTrackLike(track, prevLiked);
      notify(`Couldn't save like for "${track.title}" — please retry`);
    } finally {
      inFlightRef.current.delete(id);
    }
  }

  async function handleToggleLike(track: QueueTrack) {
    await applyTrackRating(track, "like");
  }

  async function handleToggleDislike(track: QueueTrack) {
    await applyTrackRating(track, "dislike");
  }

  async function handleToggleArtistLike(artistId: number) {
    const artist = library.artists.find(a => a.id === artistId);
    if (!artist) return;
    const prevLiked = artist.liked;
    const newLiked = nextTriState(prevLiked, "like");
    library.setArtists(prev => prev.map(a => a.id === artistId ? { ...a, liked: newLiked } : a));
    try {
      await invoke("set_entity_like_state", { kind: "artist", entity: entityLikePayload(artist.name), likeState: newLiked });
    } catch (e) {
      console.error("Failed to toggle artist like:", e);
      library.setArtists(prev => prev.map(a => a.id === artistId ? { ...a, liked: prevLiked } : a));
      notify(`Couldn't save like for "${artist.name}" — please retry`);
    }
  }

  async function handleToggleArtistDislike(artistId: number) {
    const artist = library.artists.find(a => a.id === artistId);
    if (!artist) return;
    const prevLiked = artist.liked;
    const newLiked = nextTriState(prevLiked, "dislike");
    library.setArtists(prev => prev.map(a => a.id === artistId ? { ...a, liked: newLiked } : a));
    try {
      await invoke("set_entity_like_state", { kind: "artist", entity: entityLikePayload(artist.name), likeState: newLiked });
    } catch (e) {
      console.error("Failed to toggle artist dislike:", e);
      library.setArtists(prev => prev.map(a => a.id === artistId ? { ...a, liked: prevLiked } : a));
      notify(`Couldn't save rating for "${artist.name}" — please retry`);
    }
  }

  async function handleToggleAlbumLike(albumId: number) {
    const album = library.albums.find(a => a.id === albumId);
    if (!album) return;
    const prevLiked = album.liked;
    const newLiked = nextTriState(prevLiked, "like");
    library.setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked: newLiked } : a));
    try {
      await invoke("set_entity_like_state", { kind: "album", entity: entityLikePayload(album.title, album.artist_name), likeState: newLiked });
    } catch (e) {
      console.error("Failed to toggle album like:", e);
      library.setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked: prevLiked } : a));
      notify(`Couldn't save like for "${album.title}" — please retry`);
    }
  }

  async function handleToggleAlbumDislike(albumId: number) {
    const album = library.albums.find(a => a.id === albumId);
    if (!album) return;
    const prevLiked = album.liked;
    const newLiked = nextTriState(prevLiked, "dislike");
    library.setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked: newLiked } : a));
    try {
      await invoke("set_entity_like_state", { kind: "album", entity: entityLikePayload(album.title, album.artist_name), likeState: newLiked });
    } catch (e) {
      console.error("Failed to toggle album dislike:", e);
      library.setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked: prevLiked } : a));
      notify(`Couldn't save rating for "${album.title}" — please retry`);
    }
  }

  async function handleToggleTagLike(tagId: number) {
    const tag = library.tags.find(t => t.id === tagId);
    if (!tag) return;
    const prevLiked = tag.liked;
    const newLiked = nextTriState(prevLiked, "like");
    library.setTags(prev => prev.map(t => t.id === tagId ? { ...t, liked: newLiked } : t));
    try {
      await invoke("set_entity_like_state", { kind: "tag", entity: entityLikePayload(tag.name), likeState: newLiked });
    } catch (e) {
      console.error("Failed to toggle tag like:", e);
      library.setTags(prev => prev.map(t => t.id === tagId ? { ...t, liked: prevLiked } : t));
      notify(`Couldn't save like for "${tag.name}" — please retry`);
    }
  }

  async function handleToggleTagDislike(tagId: number) {
    const tag = library.tags.find(t => t.id === tagId);
    if (!tag) return;
    const prevLiked = tag.liked;
    const newLiked = nextTriState(prevLiked, "dislike");
    library.setTags(prev => prev.map(t => t.id === tagId ? { ...t, liked: newLiked } : t));
    try {
      await invoke("set_entity_like_state", { kind: "tag", entity: entityLikePayload(tag.name), likeState: newLiked });
    } catch (e) {
      console.error("Failed to toggle tag dislike:", e);
      library.setTags(prev => prev.map(t => t.id === tagId ? { ...t, liked: prevLiked } : t));
      notify(`Couldn't save rating for "${tag.name}" — please retry`);
    }
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
  };
}
