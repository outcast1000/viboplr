import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { subscribe } from "../utils/tauriEvents";

export interface UserPlaylist {
  id: number;
  name: string;
}

interface PlaylistRow {
  id: number;
  name: string;
  saved_at: number;
  updated_at: number | null;
  system_kind: string | null;
}

/** The user's own (mutable) playlists — cached so the synchronous native-menu
 *  builders can list them in the "Add to Playlist ▸" submenu. Loaded on mount
 *  and refreshed on every backend `playlists-changed` event. Ordered by most
 *  recently USED (updated_at, falling back to creation time): the submenu is
 *  capped, so the playlists being actively maintained must float to the top. */
export function useUserPlaylists(): UserPlaylist[] {
  const [playlists, setPlaylists] = useState<UserPlaylist[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const rows = await invoke<PlaylistRow[]>("get_playlists");
        if (!alive) return;
        setPlaylists(rows
          .filter(p => p.system_kind == null)
          .sort((a, b) => (b.updated_at ?? b.saved_at) - (a.updated_at ?? a.saved_at))
          .map(p => ({ id: p.id, name: p.name })));
      } catch (e) {
        console.error("Failed to load user playlists:", e);
      }
    };
    load();
    const stop = subscribe("playlists-changed", load);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  return playlists;
}
