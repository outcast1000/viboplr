import { invoke } from "@tauri-apps/api/core";
import type { Track, Artist, Album, Tag, QueueTrack } from "../types";
import type { PluginEventName } from "../types/plugin";
import { parseLibraryId } from "../queueEntry";
import { emitTrackPatch } from "../trackEvents";

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

export function useLikeActions(deps: UseLikeActionsDeps) {
  const { library, playback, queueHook, plugins } = deps;

  async function handleToggleLike(track: QueueTrack) {
    const newLiked = track.liked === 1 ? 0 : 1;
    try {
      const directId = parseLibraryId(track.key);
      let trackId: number;
      if (directId != null) {
        trackId = directId;
      } else {
        const libTrack = await invoke<Track | null>("find_track_by_metadata", {
          title: track.title,
          artistName: track.artist_name ?? null,
          albumName: track.album_title ?? null,
        });
        if (!libTrack || libTrack.id == null) {
          return;
        }
        trackId = libTrack.id;
      }
      await invoke("toggle_liked", { kind: "track", id: trackId, liked: newLiked });
      const targetKey = directId != null ? track.key : `lib:${trackId}`;
      library.setTracks(prev => prev.map(t => t.key === targetKey ? { ...t, liked: newLiked } : t));
      if (playback.currentTrack?.key === track.key) {
        playback.setCurrentTrack(prev => prev ? { ...prev, liked: newLiked } : prev);
      }
      queueHook.setQueue(prev => prev.map(t => t.key === track.key ? { ...t, liked: newLiked } : t));
      emitTrackPatch(trackId, { liked: newLiked });
      plugins.dispatchEvent("track:liked", track, newLiked === 1);
    } catch (e) {
      console.error("Failed to toggle like:", e);
    }
  }

  async function handleToggleDislike(track: QueueTrack) {
    const newLiked = track.liked === -1 ? 0 : -1;
    try {
      const directId = parseLibraryId(track.key);
      let trackId: number;
      if (directId != null) {
        trackId = directId;
      } else {
        const libTrack = await invoke<Track | null>("find_track_by_metadata", {
          title: track.title,
          artistName: track.artist_name ?? null,
          albumName: track.album_title ?? null,
        });
        if (!libTrack || libTrack.id == null) {
          return;
        }
        trackId = libTrack.id;
      }
      await invoke("toggle_liked", { kind: "track", id: trackId, liked: newLiked });
      const targetKey = directId != null ? track.key : `lib:${trackId}`;
      library.setTracks(prev => prev.map(t => t.key === targetKey ? { ...t, liked: newLiked } : t));
      if (playback.currentTrack?.key === track.key) {
        playback.setCurrentTrack(prev => prev ? { ...prev, liked: newLiked } : prev);
      }
      queueHook.setQueue(prev => prev.map(t => t.key === track.key ? { ...t, liked: newLiked } : t));
      emitTrackPatch(trackId, { liked: newLiked });
    } catch (e) {
      console.error("Failed to toggle dislike:", e);
    }
  }

  async function handleToggleArtistLike(artistId: number) {
    const artist = library.artists.find(a => a.id === artistId);
    if (!artist) return;
    const newLiked = artist.liked === 1 ? 0 : 1;
    try {
      await invoke("toggle_liked", { kind: "artist", id: artistId, liked: newLiked });
      library.setArtists(prev => prev.map(a => a.id === artistId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle artist like:", e);
    }
  }

  async function handleToggleArtistDislike(artistId: number) {
    const artist = library.artists.find(a => a.id === artistId);
    if (!artist) return;
    const newLiked = artist.liked === -1 ? 0 : -1;
    try {
      await invoke("toggle_liked", { kind: "artist", id: artistId, liked: newLiked });
      library.setArtists(prev => prev.map(a => a.id === artistId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle artist dislike:", e);
    }
  }

  async function handleToggleAlbumLike(albumId: number) {
    const album = library.albums.find(a => a.id === albumId);
    if (!album) return;
    const newLiked = album.liked === 1 ? 0 : 1;
    try {
      await invoke("toggle_liked", { kind: "album", id: albumId, liked: newLiked });
      library.setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle album like:", e);
    }
  }

  async function handleToggleAlbumDislike(albumId: number) {
    const album = library.albums.find(a => a.id === albumId);
    if (!album) return;
    const newLiked = album.liked === -1 ? 0 : -1;
    try {
      await invoke("toggle_liked", { kind: "album", id: albumId, liked: newLiked });
      library.setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle album dislike:", e);
    }
  }

  async function handleToggleTagLike(tagId: number) {
    const tag = library.tags.find(t => t.id === tagId);
    if (!tag) return;
    const newLiked = tag.liked === 1 ? 0 : 1;
    try {
      await invoke("toggle_liked", { kind: "tag", id: tagId, liked: newLiked });
      library.setTags(prev => prev.map(t => t.id === tagId ? { ...t, liked: newLiked } : t));
    } catch (e) {
      console.error("Failed to toggle tag like:", e);
    }
  }

  async function handleToggleTagDislike(tagId: number) {
    const tag = library.tags.find(t => t.id === tagId);
    if (!tag) return;
    const newLiked = tag.liked === -1 ? 0 : -1;
    try {
      await invoke("toggle_liked", { kind: "tag", id: tagId, liked: newLiked });
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
