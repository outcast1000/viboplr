import { invoke } from "@tauri-apps/api/core";
import type { Track, Artist, Album, Tag, QueueTrack } from "../types";
import type { PluginEventName } from "../types/plugin";
import { parseLibraryId } from "../queueEntry";
import { emitTrackPatch } from "../trackEvents";
import { trackLikePayload, entityLikePayload, nextTriState } from "../likeKeys";

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
}

// A queue/now-playing entry is the same song as `track` when its in-memory key
// matches, OR — for copies that came from a different surface (external source,
// restored playlist, a duplicate add) and so carry a different `ext:N`/`lib:N`
// key — when title + artist match. Without the metadata fallback, liking a song
// from one surface would leave a same-song copy elsewhere in the queue stale.
export function sameSong(a: QueueTrack, b: QueueTrack): boolean {
  if (a.key === b.key) return true;
  return a.title === b.title && (a.artist_name ?? null) === (b.artist_name ?? null);
}

export function useLikeActions(deps: UseLikeActionsDeps) {
  const { library, playback, queueHook, plugins } = deps;

  async function handleToggleLike(track: QueueTrack) {
    const newLiked = nextTriState(track.liked, "like");
    try {
      await invoke("set_entity_like_state", {
        kind: "track",
        entity: trackLikePayload(track),
        likeState: newLiked,
      });
      // Mirror state in any matching library track + currentTrack + queue (by key).
      const directId = parseLibraryId(track.key);
      if (directId != null) {
        library.setTracks(prev => prev.map(t => t.key === track.key ? { ...t, liked: newLiked } : t));
        emitTrackPatch(directId, { liked: newLiked });
      } else {
        // External track: still patch any library row that matches by metadata, best-effort.
        library.setTracks(prev => prev.map(t =>
          t.title === track.title && (t.artist_name ?? null) === (track.artist_name ?? null)
            ? { ...t, liked: newLiked } : t));
      }
      if (playback.currentTrack && sameSong(playback.currentTrack, track)) {
        playback.setCurrentTrack(prev => prev ? { ...prev, liked: newLiked } : prev);
      }
      queueHook.setQueue(prev => prev.map(t => sameSong(t, track) ? { ...t, liked: newLiked } : t));
      plugins.dispatchEvent("track:liked", track, newLiked === 1);
    } catch (e) {
      console.error("Failed to toggle like:", e);
    }
  }

  async function handleToggleDislike(track: QueueTrack) {
    const newLiked = nextTriState(track.liked, "dislike");
    try {
      await invoke("set_entity_like_state", {
        kind: "track",
        entity: trackLikePayload(track),
        likeState: newLiked,
      });
      const directId = parseLibraryId(track.key);
      if (directId != null) {
        library.setTracks(prev => prev.map(t => t.key === track.key ? { ...t, liked: newLiked } : t));
        emitTrackPatch(directId, { liked: newLiked });
      } else {
        library.setTracks(prev => prev.map(t =>
          t.title === track.title && (t.artist_name ?? null) === (track.artist_name ?? null)
            ? { ...t, liked: newLiked } : t));
      }
      if (playback.currentTrack && sameSong(playback.currentTrack, track)) {
        playback.setCurrentTrack(prev => prev ? { ...prev, liked: newLiked } : prev);
      }
      queueHook.setQueue(prev => prev.map(t => sameSong(t, track) ? { ...t, liked: newLiked } : t));
    } catch (e) {
      console.error("Failed to toggle dislike:", e);
    }
  }

  async function handleToggleArtistLike(artistId: number) {
    const artist = library.artists.find(a => a.id === artistId);
    if (!artist) return;
    const newLiked = nextTriState(artist.liked, "like");
    try {
      await invoke("set_entity_like_state", { kind: "artist", entity: entityLikePayload(artist.name), likeState: newLiked });
      library.setArtists(prev => prev.map(a => a.id === artistId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle artist like:", e);
    }
  }

  async function handleToggleArtistDislike(artistId: number) {
    const artist = library.artists.find(a => a.id === artistId);
    if (!artist) return;
    const newLiked = nextTriState(artist.liked, "dislike");
    try {
      await invoke("set_entity_like_state", { kind: "artist", entity: entityLikePayload(artist.name), likeState: newLiked });
      library.setArtists(prev => prev.map(a => a.id === artistId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle artist dislike:", e);
    }
  }

  async function handleToggleAlbumLike(albumId: number) {
    const album = library.albums.find(a => a.id === albumId);
    if (!album) return;
    const newLiked = nextTriState(album.liked, "like");
    try {
      await invoke("set_entity_like_state", { kind: "album", entity: entityLikePayload(album.title, album.artist_name), likeState: newLiked });
      library.setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle album like:", e);
    }
  }

  async function handleToggleAlbumDislike(albumId: number) {
    const album = library.albums.find(a => a.id === albumId);
    if (!album) return;
    const newLiked = nextTriState(album.liked, "dislike");
    try {
      await invoke("set_entity_like_state", { kind: "album", entity: entityLikePayload(album.title, album.artist_name), likeState: newLiked });
      library.setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle album dislike:", e);
    }
  }

  async function handleToggleTagLike(tagId: number) {
    const tag = library.tags.find(t => t.id === tagId);
    if (!tag) return;
    const newLiked = nextTriState(tag.liked, "like");
    try {
      await invoke("set_entity_like_state", { kind: "tag", entity: entityLikePayload(tag.name), likeState: newLiked });
      library.setTags(prev => prev.map(t => t.id === tagId ? { ...t, liked: newLiked } : t));
    } catch (e) {
      console.error("Failed to toggle tag like:", e);
    }
  }

  async function handleToggleTagDislike(tagId: number) {
    const tag = library.tags.find(t => t.id === tagId);
    if (!tag) return;
    const newLiked = nextTriState(tag.liked, "dislike");
    try {
      await invoke("set_entity_like_state", { kind: "tag", entity: entityLikePayload(tag.name), likeState: newLiked });
      library.setTags(prev => prev.map(t => t.id === tagId ? { ...t, liked: newLiked } : t));
    } catch (e) {
      console.error("Failed to toggle tag dislike:", e);
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
