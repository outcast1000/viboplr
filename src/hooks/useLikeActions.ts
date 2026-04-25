import { invoke } from "@tauri-apps/api/core";
import type { Track, Artist, Album, Tag } from "../types";
import type { PluginEventName } from "../types/plugin";

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
  currentTrack: Track | null;
  setCurrentTrack: (t: Track) => void;
}

interface QueueDeps {
  setQueue: React.Dispatch<React.SetStateAction<Track[]>>;
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

  async function handleToggleLike(track: Track) {
    if (track.id == null) return;
    const newLiked = track.liked === 1 ? 0 : 1;
    try {
      await invoke("toggle_liked", { kind: "track", id: track.id, liked: newLiked });
      library.setTracks(prev => prev.map(t => t.key === track.key ? { ...t, liked: newLiked } : t));
      if (playback.currentTrack?.key === track.key) {
        playback.setCurrentTrack({ ...playback.currentTrack, liked: newLiked });
      }
      queueHook.setQueue(prev => prev.map(t => t.key === track.key ? { ...t, liked: newLiked } : t));
      plugins.dispatchEvent("track:liked", track, newLiked === 1);
    } catch (e) {
      console.error("Failed to toggle like:", e);
    }
  }

  async function handleToggleDislike(track: Track) {
    if (track.id == null) return;
    const newLiked = track.liked === -1 ? 0 : -1;
    try {
      await invoke("toggle_liked", { kind: "track", id: track.id, liked: newLiked });
      library.setTracks(prev => prev.map(t => t.key === track.key ? { ...t, liked: newLiked } : t));
      if (playback.currentTrack?.key === track.key) {
        playback.setCurrentTrack({ ...playback.currentTrack, liked: newLiked });
      }
      queueHook.setQueue(prev => prev.map(t => t.key === track.key ? { ...t, liked: newLiked } : t));
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

  async function handleToggleArtistHate(artistId: number) {
    const artist = library.artists.find(a => a.id === artistId);
    if (!artist) return;
    const newLiked = artist.liked === -1 ? 0 : -1;
    try {
      await invoke("toggle_liked", { kind: "artist", id: artistId, liked: newLiked });
      library.setArtists(prev => prev.map(a => a.id === artistId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle artist hate:", e);
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

  async function handleToggleAlbumHate(albumId: number) {
    const album = library.albums.find(a => a.id === albumId);
    if (!album) return;
    const newLiked = album.liked === -1 ? 0 : -1;
    try {
      await invoke("toggle_liked", { kind: "album", id: albumId, liked: newLiked });
      library.setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked: newLiked } : a));
    } catch (e) {
      console.error("Failed to toggle album hate:", e);
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

  async function handleToggleTagHate(tagId: number) {
    const tag = library.tags.find(t => t.id === tagId);
    if (!tag) return;
    const newLiked = tag.liked === -1 ? 0 : -1;
    try {
      await invoke("toggle_liked", { kind: "tag", id: tagId, liked: newLiked });
      library.setTags(prev => prev.map(t => t.id === tagId ? { ...t, liked: newLiked } : t));
    } catch (e) {
      console.error("Failed to toggle tag hate:", e);
    }
  }

  return {
    handleToggleLike,
    handleToggleDislike,
    handleToggleArtistLike,
    handleToggleArtistHate,
    handleToggleAlbumLike,
    handleToggleAlbumHate,
    handleToggleTagLike,
    handleToggleTagHate,
  };
}
