// Vinyl Deck — presses the live play queue onto a single-sided record.
//
// A visualizer plugin: it contributes the deck to the host's `nowplaying` slot
// and owns nothing but its own presentation settings. The host drives the frame
// loop and supplies live playback state; the deck's only writes are seek and
// play-queue-index.
//
// Built by vite into a single IIFE (see vite.config.ts), so the host's existing
// `new Function("api", code)` loader is unchanged — the build step is purely
// author-side.

import type { ViboplrPluginAPI } from "../../../../src/types/plugin";
import type { VinylComposition } from "./geometry";
import { createVinylDeckVisualizer, type DeckOptions } from "./visualizer";

const STORE_KEY = "settings";

const DEFAULTS: DeckOptions = {
  composition: "full",
  tilt: 0,
  emphasiseGaps: false,
};

const TILTS = [0, 16, 28, 42];

/**
 * One live options object, shared by reference with every mounted visualizer.
 *
 * The host re-mounts only when the slot's selection changes, so a settings
 * change would otherwise never reach a running deck. Mutating this in place lets
 * it pick the change up on its next frame.
 */
const options: DeckOptions = { ...DEFAULTS };

export function activate(api: ViboplrPluginAPI) {
  function save() {
    api.storage.set(STORE_KEY, options).catch((e) => {
      api.log("error", `Failed to save settings: ${e}`, "vinyl-deck");
    });
  }

  function renderSettings() {
    api.ui.setViewData("vinyl-deck-settings", {
      type: "section",
      title: "Vinyl Deck",
      children: [
        {
          type: "text",
          content:
            "Right-click the Now Playing artwork to put the deck in that slot.",
          className: "settings-hint",
        },
        // `select` / `toggle` carry their own label + description, so they go in
        // directly rather than nested in a `settings-row` that would repeat it.
        {
          type: "select",
          label: "Composition",
          description:
            "A record is radially symmetric, so the right-hand rim duplicates the left. Cropping it spends those pixels on magnification instead.",
          action: "set-composition",
          value: options.composition,
          options: [
            { value: "full", label: "Full disc" },
            { value: "left-two-thirds", label: "Left two-thirds (magnified)" },
          ],
        },
        {
          type: "select",
          label: "Platter tilt",
          description:
            "Cueing is exact when flat; while tilted the radius is read from the on-screen projection.",
          action: "set-tilt",
          value: String(options.tilt),
          options: TILTS.map((t) => ({
            value: String(t),
            label: t === 0 ? "Flat" : `${t}°`,
          })),
        },
        {
          type: "toggle",
          label: "Outline the track gaps",
          description:
            "The land between tracks is smooth black, read by its glint. Outline it when you want to read the structure deliberately.",
          action: "set-gaps",
          checked: options.emphasiseGaps,
        },
      ],
    });
  }

  api.ui.onAction("set-composition", (v) => {
    const raw = typeof v === "string" ? v : (v as { value?: string })?.value;
    if (raw === "full" || raw === "left-two-thirds") {
      options.composition = raw as VinylComposition;
      save();
      renderSettings();
    }
  });

  api.ui.onAction("set-tilt", (v) => {
    const raw = typeof v === "string" ? v : (v as { value?: string })?.value;
    const n = Number.parseInt(String(raw), 10);
    options.tilt = Number.isNaN(n) ? 0 : n;
    save();
    renderSettings();
  });

  api.ui.onAction("set-gaps", (v) => {
    options.emphasiseGaps = typeof v === "boolean" ? v : !options.emphasiseGaps;
    save();
    renderSettings();
  });

  // A fresh instance per occupied slot — the same deck may be in two at once,
  // and they must not share DOM. All of them read the one live options object.
  api.visualizers.onMount("deck", () => createVinylDeckVisualizer(options));

  api.storage
    .get<Partial<DeckOptions>>(STORE_KEY)
    .then((saved) => {
      if (saved && typeof saved === "object") Object.assign(options, saved);
      renderSettings();
    })
    .catch((e) => {
      api.log("error", `Failed to load settings: ${e}`, "vinyl-deck");
      renderSettings();
    });
}

export function deactivate() {
  // The host drops the visualizer factory and every api.* subscription on
  // unload, and destroys any mounted instance. Nothing else to release.
}
