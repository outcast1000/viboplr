// Which visualizer fills which slot. Pure, so the rules are assertable without
// mounting anything.

import type {
  PluginVisualizerPlacement,
  PluginVisualizerRegistration,
} from "../types/pluginVisualizer";
import type { MenuItemSpec } from "../nativeMenu";

/** Persisted as `visualizerSlots` in the app store. */
export type VisualizerSlotSelection = Partial<Record<PluginVisualizerPlacement, string | null>>;

/** Stable key for a registration: `pluginId:visualizerId`. */
export function visualizerKey(v: PluginVisualizerRegistration): string {
  return `${v.pluginId}:${v.id}`;
}

/**
 * The retired built-in Photos visualizer's key. Photos is now an Artwork option
 * ("Show additional images", `ArtworkOptions.extraImages`), not a pick of its
 * own. A stored `visualizerSlots` that still names it resolves to Artwork, and
 * `artworkOptionsWithLegacyPhotos` reads it as that option turned on until the
 * user sets the option. Nothing rewrites the store for it.
 */
export const LEGACY_PHOTOS_VISUALIZER_KEY = "core:photos";

/**
 * How the Artwork pick draws the Now Playing stage. Plugin visualizers ignore
 * all four: a vinyl deck has nothing to do with lyrics or a bio, so a plugin
 * pick gets the whole stage with no side column.
 *
 * Lyrics and info share the side column; with both on, info takes it.
 */
export interface ArtworkOptions {
  /** The slideshow also deals the plugins' pictures of the song, its artist and
      its album (`useNowPlayingPhotos`), after the cover and artist image. */
  extraImages: boolean;
  /** The lyrics column. Stored inverted as `nowPlayingLyricsHidden`. */
  lyrics: boolean;
  /** The About prose (song / artist / album) in the side column. */
  info: boolean;
  /** The picture covers the whole view instead of a framed square over a
      blurred backdrop; lyrics or info sit over it on a scrim. */
  fill: boolean;
}

/** Persisted as `nowPlayingArtwork`; lyrics keeps its own `nowPlayingLyricsHidden`
    key (the control API and the capture scenes read it). `extraImagesSet` records
    that the user has set the option, which retires the legacy Photos pick. */
export interface StoredArtworkOptions {
  extraImages: boolean;
  extraImagesSet: boolean;
  info: boolean;
  fill: boolean;
}
export const DEFAULT_ARTWORK_OPTIONS: StoredArtworkOptions = {
  extraImages: false,
  extraImagesSet: false,
  info: false,
  fill: false,
};

/** The Artwork options in effect. A profile that picked the old Photos
    visualizer keeps its pictures until the user sets the option. */
export function resolveArtworkOptions(
  stored: StoredArtworkOptions,
  lyricsHidden: boolean,
  selection: VisualizerSlotSelection,
): ArtworkOptions {
  // `=== true` per field: the store only checks that the saved value is an
  // object, so a partial or hand-edited one must read as "off", not undefined.
  const legacyPhotos = stored.extraImagesSet !== true && selection.nowplaying === LEGACY_PHOTOS_VISUALIZER_KEY;
  return {
    extraImages: stored.extraImages === true || legacyPhotos,
    lyrics: lyricsHidden !== true,
    info: stored.info === true,
    fill: stored.fill === true,
  };
}

/** Visualizers willing to fill this slot. */
export function candidatesFor(
  visualizers: PluginVisualizerRegistration[],
  placement: PluginVisualizerPlacement,
): PluginVisualizerRegistration[] {
  return visualizers.filter((v) => v.placements?.includes(placement));
}

/**
 * Resolve what a slot should actually render.
 *
 * Returns null when the selection names a visualizer that isn't available —
 * its plugin was disabled, uninstalled, or dropped the contribution in an
 * update. The slot then renders as empty rather than erroring: a stale
 * selection is a normal state, not a fault, and the user's choice is left in
 * the store so it comes back if they re-enable the plugin.
 */
export function resolveSlot(
  visualizers: PluginVisualizerRegistration[],
  selection: VisualizerSlotSelection,
  placement: PluginVisualizerPlacement,
): string | null {
  const key = selection[placement];
  if (!key || key === LEGACY_PHOTOS_VISUALIZER_KEY) return null;
  const available = candidatesFor(visualizers, placement).some((v) => visualizerKey(v) === key);
  return available ? key : null;
}

/**
 * Resolve the `fullscreen` slot, falling back to the Now Playing pick.
 *
 * Going fullscreen from the Now Playing view means "show me this, bigger" —
 * so the slot inherits whatever is already on screen, provided that visualizer
 * declares it can fill it. Treating fullscreen as a second, separately-chosen
 * visualizer would leave the obvious gesture doing nothing until the user found
 * a setting they had no reason to look for.
 *
 * An explicit `fullscreen` selection still wins, so the key keeps its meaning
 * for a visualizer that is only worth showing at full size. Nothing sets it
 * today — it is honoured, not offered.
 */
export function resolveFullscreenSlot(
  visualizers: PluginVisualizerRegistration[],
  selection: VisualizerSlotSelection,
): string | null {
  const explicit = resolveSlot(visualizers, selection, "fullscreen");
  if (explicit) return explicit;
  const nowPlaying = resolveSlot(visualizers, selection, "nowplaying");
  if (!nowPlaying) return null;
  const willing = candidatesFor(visualizers, "fullscreen").some(
    (v) => visualizerKey(v) === nowPlaying,
  );
  return willing ? nowPlaying : null;
}

/**
 * The built-in choice: fill the slot with the track's own artwork.
 *
 * This used to be presented as **"None"**, which described the mechanism and
 * misdescribed the result — an unselected slot has never rendered nothing, it
 * renders the image-provider chain's answer for the track (explicit `image_url`
 * → album image → artist image → the letter placeholder). So "None" told the user
 * their choice was an absence when it was in fact the default visual, and made a
 * freshly-installed plugin look like the only thing on the list that *did*
 * anything.
 *
 * It is still persisted as `null`, deliberately. Giving it a key would mean
 * migrating every stored `visualizerSlots` and teaching `resolveSlot` /
 * `VisualizerSlot` about a visualizer with no plugin and no factory behind it —
 * all to store a different spelling of the same state. The rename is a
 * presentation change, and stays one.
 */
export const ARTWORK_VISUALIZER_NAME = "Artwork";

/**
 * Native menu for picking a slot's visualizer — a check list of every option,
 * artwork included. Native, per the app-wide rule that every menu is an OS menu;
 * returns specs so the item set is assertable without a DOM.
 *
 * Artwork leads the list as a peer of the plugins rather than sitting above a
 * separator, because it is one: picking it is a choice about what fills the slot,
 * not a refusal to choose.
 *
 * With `artwork` passed, Artwork's options follow the list under a separator
 * (owner decision, 2026-11-08: lyrics, info and extra pictures are ways of
 * drawing the artwork, not view buttons of their own). They are disabled while
 * a plugin visualizer is live, since it uses none of them. `artwork.live` says
 * whether Artwork is what the surface the picker opened from actually shows —
 * fullscreen resolves its own slot (`resolveFullscreenSlot`), so it can differ
 * from `placement`'s pick; without it, `placement`'s pick decides.
 */
export function buildVisualizerMenuSpecs(
  visualizers: PluginVisualizerRegistration[],
  selection: VisualizerSlotSelection,
  placement: PluginVisualizerPlacement,
  onPick: (key: string | null) => void,
  artwork?: { options: ArtworkOptions; onToggle: (option: keyof ArtworkOptions) => void; live?: boolean },
): MenuItemSpec[] {
  const candidates = candidatesFor(visualizers, placement);
  const current = resolveSlot(visualizers, selection, placement);

  // Checked whenever no plugin visualizer is live — which includes a *stale*
  // selection (plugin disabled or uninstalled), since that is what the slot is
  // actually showing. The list never names something that isn't on screen.
  const specs: MenuItemSpec[] = [
    {
      kind: "check",
      text: ARTWORK_VISUALIZER_NAME,
      checked: current === null,
      action: () => onPick(null),
    },
  ];

  for (const v of candidates) {
    const key = visualizerKey(v);
    specs.push({
      kind: "check",
      text: v.name,
      checked: current === key,
      action: () => onPick(key),
    });
  }

  // Nothing installed: keep the hint that was the whole value of the old empty
  // state, but below a real checked entry instead of replacing one. The picker
  // previously showed *only* this line, so it couldn't say what was on screen.
  if (candidates.length === 0) {
    specs.push(
      { kind: "separator" },
      {
        kind: "item",
        text: "No visualizer plugins installed",
        enabled: false,
        action: () => {},
      },
    );
  }

  if (artwork) {
    specs.push({ kind: "separator" });
    for (const option of ARTWORK_OPTION_ORDER) {
      specs.push({
        kind: "check",
        text: ARTWORK_OPTION_LABELS[option],
        checked: artwork.options[option],
        enabled: artwork.live ?? current === null,
        action: () => artwork.onToggle(option),
      });
    }
  }

  return specs;
}

/** The Artwork options' menu labels. */
export const ARTWORK_OPTION_LABELS: Record<keyof ArtworkOptions, string> = {
  extraImages: "Show additional images",
  lyrics: "Show lyrics",
  info: "Show info",
  fill: "Images fill the view",
};
const ARTWORK_OPTION_ORDER: (keyof ArtworkOptions)[] = ["extraImages", "lyrics", "info", "fill"];
