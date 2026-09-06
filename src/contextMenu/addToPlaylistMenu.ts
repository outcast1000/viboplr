// "Add to Playlist ▸" native submenu builder — pure, shared by
// buildContextMenuSpecs (library/queue surfaces) and PlaylistsView (detail
// track menu) so the two surfaces can't drift.
import type { MenuItemSpec } from "../nativeMenu";

export interface AddToPlaylistTarget {
  id: number;
  name: string;
}

/** How many playlists the submenu lists before deferring to the searchable
 *  picker. A native submenu past this length is a scroll, not a menu. */
export const ADD_TO_PLAYLIST_MENU_CAP = 12;

export interface AddToPlaylistCallbacks {
  /** Append the target's tracks to an existing user playlist. */
  onPick: (playlistId: number, playlistName: string) => void;
  /** Create a new playlist from the target's tracks (opens the save modal). */
  onNew: () => void;
  /** Open the searchable playlist picker (only offered past the cap). */
  onBrowse?: () => void;
  /** Hide this playlist from the list (a playlist detail view excludes itself). */
  excludeId?: number;
}

/** Build the "Add to Playlist" submenu spec: the most recently used playlists
 *  first (callers pass them recency-ordered), capped at
 *  ADD_TO_PLAYLIST_MENU_CAP with an "All N playlists…" picker entry when the
 *  list overflows, then "New playlist…" last. */
export function buildAddToPlaylistSubmenu(
  playlists: AddToPlaylistTarget[],
  { onPick, onNew, onBrowse, excludeId }: AddToPlaylistCallbacks,
): MenuItemSpec {
  const listed = excludeId != null ? playlists.filter(pl => pl.id !== excludeId) : playlists;
  const capped = onBrowse != null && listed.length > ADD_TO_PLAYLIST_MENU_CAP;
  const shown = capped ? listed.slice(0, ADD_TO_PLAYLIST_MENU_CAP) : listed;

  const items: MenuItemSpec[] = shown.map(pl => (
    { kind: "item", text: pl.name, action: () => onPick(pl.id, pl.name) }
  ));
  if (capped) {
    items.push({ kind: "item", text: `All ${listed.length} playlists…`, action: onBrowse! });
  }
  if (items.length > 0) {
    items.push({ kind: "separator" });
  }
  items.push({ kind: "item", text: "New playlist…", action: onNew });
  return { kind: "submenu", text: "Add to Playlist", items };
}
