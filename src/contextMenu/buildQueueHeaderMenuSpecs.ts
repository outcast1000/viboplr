// Queue header (⋯) menu spec builder, extracted from QueuePanel.
//
// Pure: given the queue-level callbacks, returns the MenuItemSpec[] to
// display. QueuePanel keeps a thin useCallback wrapper that owns the anchor
// rect + showNativeMenu. (Prefer video and Randomize are visible header
// buttons, not menu items — a mode that changes what every play does must not
// hide behind a ⋯.)
//
// Extracted for the same reason buildContextMenuSpecs was: showNativeMenu opens
// a native OS menu with no DOM, so every item behind it — including "Clear
// playlist", the only way to clear the queue — is unreachable from a test that
// drives the webview. Building the specs separately makes the menu's contents
// and wiring assertable without a Tauri build.
import type { MenuItemSpec } from "../nativeMenu";

export interface QueueHeaderMenuDeps {
  onLoadPlaylist: () => void;
  onSaveToPlaylists: () => void;
  onSaveAsM3U: () => void;
  onPublishQueue: () => void;
  onExportAsMixtape: () => void;
  onClear: () => void;
}

/**
 * Build the queue header's native menu. This is the single home for every
 * queue-level action — new ones belong here, not as extra header buttons (see
 * ui.md "Queue Panel").
 */
export function buildQueueHeaderMenuSpecs(d: QueueHeaderMenuDeps): MenuItemSpec[] {
  return [
    { kind: "item", text: "Load playlist…", action: d.onLoadPlaylist },
    {
      kind: "submenu",
      text: "Save",
      items: [
        { kind: "item", text: "Save as Playlist", action: d.onSaveToPlaylists },
        { kind: "item", text: "Export as M3U", action: d.onSaveAsM3U },
      ],
    },
    {
      kind: "submenu",
      text: "Share",
      items: [
        { kind: "item", text: "Publish hosted source…", action: d.onPublishQueue },
        { kind: "item", text: "Save as file (.mixtape)…", action: d.onExportAsMixtape },
      ],
    },
    { kind: "separator" },
    { kind: "item", text: "Clear queue", action: d.onClear },
  ];
}
