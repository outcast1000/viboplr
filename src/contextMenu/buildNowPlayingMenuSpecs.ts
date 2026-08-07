// Now Playing view (⋯ / right-click) menu spec builder.
//
// Pure, for the same reason buildQueueHeaderMenuSpecs is: showNativeMenu opens a
// native OS menu with no DOM, so nothing behind it can be clicked from a test.
// Building the specs separately makes the item set, its check state, and its
// wiring assertable without a Tauri build.
//
// This menu is also the *discoverable* route to the visualizer picker. Before
// it, the only ways in were a right-click on the artwork with no affordance
// hinting at it, and a select buried in Settings → Playback — so a user who
// installed a visualizer plugin had no reason to believe anything had changed.
import type { MenuItemSpec } from "../nativeMenu";
import type { PluginVisualizerRegistration } from "../types/pluginVisualizer";
import {
  buildVisualizerMenuSpecs,
  type VisualizerSlotSelection,
} from "../utils/visualizerSlots";

export interface NowPlayingMenuDeps {
  visualizers: PluginVisualizerRegistration[];
  selection: VisualizerSlotSelection;
  onPickVisualizer: (key: string | null) => void;
  /** Whether this track has lyrics at all — nothing to show or hide without them. */
  hasLyrics: boolean;
  lyricsHidden: boolean;
  onToggleLyrics: () => void;
  /**
   * Go fullscreen. Null only when there is nothing playing — a visualizer is
   * what *fills* the screen when one is selected, not a precondition for the
   * feature, so this is not gated on having one.
   */
  onEnterFullscreen: (() => void) | null;
}

export function buildNowPlayingMenuSpecs(d: NowPlayingMenuDeps): MenuItemSpec[] {
  const specs: MenuItemSpec[] = [
    {
      kind: "submenu",
      text: "Visualizer",
      items: buildVisualizerMenuSpecs(
        d.visualizers,
        d.selection,
        "nowplaying",
        d.onPickVisualizer,
      ),
    },
  ];

  if (d.onEnterFullscreen) {
    // Just "Fullscreen": the same word the video surface uses, because it is the
    // same feature. No key hint — the binding is Cmd+F on macOS and Ctrl+F
    // elsewhere, and no other native menu in the app annotates its shortcuts, so
    // a single hardcoded string would be wrong on one platform for no gain.
    specs.push({ kind: "item", text: "Fullscreen", action: d.onEnterFullscreen });
  }

  specs.push(
    { kind: "separator" },
    {
      kind: "check",
      text: "Show lyrics",
      // Checked reflects what is actually on screen, so an unchecked box on a
      // track with no lyrics reads as "there are none" rather than lying about
      // a preference the user never set.
      checked: d.hasLyrics && !d.lyricsHidden,
      enabled: d.hasLyrics,
      action: d.onToggleLyrics,
    },
  );

  return specs;
}
