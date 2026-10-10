export type SettingsTab = "general" | "playback" | "scrobbling" | "providers" | "ai" | "debug";

/** Which tab owns a deep-linkable Settings section id. Sections not listed
 *  live in the default (General) tab. Keep in step with the `id="…"`
 *  attributes in `SettingsPanel.tsx`.
 *
 *  Lives outside the component so the control API (`utils/uiControl.ts`) can
 *  validate `navigate { settings: "<id>" }` against the same list the panel
 *  scrolls with — a section added here is reachable from both at once. */
export const SECTION_TABS: Record<string, SettingsTab> = {
  "playback-engine": "playback",
  "exclusive-audio": "playback",
  "now-playing-info": "playback",
  "radio": "playback",
  "auto-continue": "playback",
  "player-bar": "playback",
  // The update notice banner's "Details" lands here.
  "app-update": "general",
  "control-api": "ai",
  // The assistant activity pill's "Open full log" lands here.
  "assistant-activity": "ai",
  "scrobbling": "scrobbling",
};

export const SETTINGS_SECTION_IDS = Object.keys(SECTION_TABS);
