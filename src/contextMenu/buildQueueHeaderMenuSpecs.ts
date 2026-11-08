// Queue header (⋯) menu spec builder, extracted from QueuePanel.
//
// Pure: given the queue-level state + callbacks, returns the MenuItemSpec[] to
// display. QueuePanel keeps a thin useCallback wrapper that owns the anchor
// rect + showNativeMenu. (Queue mode, auto-continue and Randomize are visible
// header buttons, not menu items. Prefer video is a check item here; it is
// never on silently, because the list's own banner announces it with Turn off.)
//
// Extracted for the same reason buildContextMenuSpecs was: showNativeMenu opens
// a native OS menu with no DOM, so every item behind it is unreachable from a
// test that drives the webview. (There is no Clear: the queue's Back / Forward
// history undoes any replacement, which made emptying the queue pointless —
// queue.md "Queue History". Only the control API still clears it.) Building the specs separately makes the menu's contents
// and wiring assertable without a Tauri build.
import type { MenuItemSpec } from "../nativeMenu";

export interface QueueHeaderMenuDeps {
  preferVideo: boolean;
  onTogglePreferVideo: () => void;
  onLoadPlaylist: () => void;
  onSaveToPlaylists: () => void;
  onSaveAsM3U: () => void;
  onPublishQueue: () => void;
  onExportAsMixtape: () => void;
  onOpenAutoContinueSettings: () => void;
  /** Back / Forward, passed only while the header is too narrow to show their
   *  buttons (QueuePanel.css hides that segment below 230px): they then lead the
   *  menu, so the queue history is never out of reach. */
  history?: {
    back: { name: string } | null;
    forward: { name: string } | null;
    onBack: () => void;
    onForward: () => void;
    /** "⌘[" / "Ctrl+[" — the buttons' tooltips name the shortcut, so the
     *  menu items standing in for them do too. */
    backShortcut?: string;
    forwardShortcut?: string;
  } | null;
}

function withShortcut(text: string, shortcut: string | undefined): string {
  return shortcut ? `${text} (${shortcut})` : text;
}

/**
 * Build the queue header's native menu. This is the single home for every
 * queue-level action — new ones belong here, not as extra header buttons (see
 * ui.md "Queue Panel").
 */
export function buildQueueHeaderMenuSpecs(d: QueueHeaderMenuDeps): MenuItemSpec[] {
  const history: MenuItemSpec[] = d.history
    ? [
      {
        kind: "item",
        text: withShortcut(d.history.back ? `Back to: ${d.history.back.name}` : "Back: no earlier queue", d.history.backShortcut),
        enabled: !!d.history.back,
        action: d.history.onBack,
      },
      {
        kind: "item",
        text: withShortcut(d.history.forward ? `Forward to: ${d.history.forward.name}` : "Forward: no later queue", d.history.forwardShortcut),
        enabled: !!d.history.forward,
        action: d.history.onForward,
      },
      { kind: "separator" },
    ]
    : [];
  return [
    ...history,
    { kind: "check", text: "Prefer video", checked: d.preferVideo, action: d.onTogglePreferVideo },
    { kind: "separator" },
    { kind: "item", text: "Load playlist…", action: d.onLoadPlaylist },
    {
      kind: "submenu",
      text: "Save",
      items: [
        { kind: "item", text: "Save as Playlist", action: d.onSaveToPlaylists },
        { kind: "item", text: "Export as M3U", action: d.onSaveAsM3U },
        { kind: "item", text: "Export as Mixtape…", action: d.onExportAsMixtape },
      ],
    },
    { kind: "item", text: "Publish hosted source…", action: d.onPublishQueue },
    { kind: "separator" },
    { kind: "item", text: "Auto-continue settings…", action: d.onOpenAutoContinueSettings },
  ];
}
