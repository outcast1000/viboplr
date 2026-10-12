// "What is the user looking at" — one answer for plugins (`api.ui.getContext` /
// `onContextChanged`, permission `ui:read`) and AI assistants (the control API's
// `ui.get`), built here so the two can't drift.
//
// Deliberately coarse: the page, its subject by name, whether Now Playing is up,
// and whether the window is on screen at all. Never what the user typed (search
// boxes, form fields), what a modal says, or scroll position — "which page" is
// useful to a plugin, "what you typed" is private.

import type { View } from "../types";

export type UiContextView =
  | "home" | "library" | "artist" | "album" | "tag" | "track" | "history"
  | "collections" | "playlists" | "nowplaying" | "settings" | "extensions"
  | "plugin" | "other";

export interface UiContextEntity {
  kind: "artist" | "album" | "tag" | "track";
  name: string;
  /** Album: the album artist. Track: the track artist. */
  artistName: string | null;
  /** Track pages only. */
  albumTitle: string | null;
}

export interface UiContext {
  view: UiContextView;
  /** The open detail page's subject, by name (pages for things not in the library have no id). */
  entity: UiContextEntity | null;
  /** The Now Playing surface — the view, or the audio fullscreen overlay. */
  nowPlaying: { visible: boolean; fullscreen: boolean };
  pluginView: { pluginId: string; viewId: string } | null;
  /** Whether the user can see the app at all: an occluded or minimized window
   *  shows nothing, whatever its view says. */
  window: { visible: boolean; focused: boolean; mini: boolean };
}

export interface UiContextInput {
  view: View;
  /** The detail page that is open, already resolved to names by App. */
  entity: UiContextEntity | null;
  audioFullscreen: boolean;
  windowVisible: boolean;
  windowFocused: boolean;
  mini: boolean;
}

const PLAIN_VIEWS: Partial<Record<string, UiContextView>> = {
  home: "home", search: "library", history: "history", collections: "collections",
  playlists: "playlists", nowplaying: "nowplaying", settings: "settings", extensions: "extensions",
};

export function buildUiContext(input: UiContextInput): UiContext {
  let pluginView: UiContext["pluginView"] = null;
  let view: UiContextView;
  if (input.entity) {
    // A detail page draws over whichever list view it was opened from.
    view = input.entity.kind;
  } else if (input.view.startsWith("plugin:")) {
    const [, pluginId = "", ...rest] = input.view.split(":");
    pluginView = { pluginId, viewId: rest.join(":") };
    view = "plugin";
  } else {
    view = PLAIN_VIEWS[input.view] ?? "other";
  }
  const nowPlayingUp = input.audioFullscreen || (view === "nowplaying" && !input.mini);
  // Frozen all the way down: one object is handed to every plugin and to the
  // control API, so a plugin must not be able to change what the others see.
  return Object.freeze({
    view,
    entity: input.entity ? Object.freeze({ ...input.entity }) : null,
    nowPlaying: Object.freeze({ visible: nowPlayingUp && input.windowVisible, fullscreen: input.audioFullscreen }),
    pluginView: pluginView ? Object.freeze(pluginView) : null,
    window: Object.freeze({ visible: input.windowVisible, focused: input.windowFocused, mini: input.mini }),
  });
}

/** A stable key for identity: equal contexts give equal keys. */
export function uiContextKey(ctx: UiContext): string {
  return JSON.stringify(ctx);
}

/** The key change *announcements* compare: focus is left out, so switching to
 *  another app and back (the page unchanged) doesn't wake every `ui:read` plugin.
 *  `getContext` still reports it. */
export function uiContextAnnounceKey(ctx: UiContext): string {
  return JSON.stringify({ ...ctx, window: { visible: ctx.window.visible, mini: ctx.window.mini } });
}
