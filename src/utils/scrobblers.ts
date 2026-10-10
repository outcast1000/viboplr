// Which scrobblers record which plays (Settings → Scrobbling). A "scrobbler"
// is anything that is told a track was played once it passes the scrobble
// threshold (`shouldScrobble`): the app's own local history (`record_play`)
// and every plugin subscribed to `track:scrobbled` (Last.fm, Community,
// Subsonic…). The threshold is detected once, in usePlayback; this setting
// only decides who hears about it, per media type.
//
// Persisted as one store key, `scrobbleSettings`. A scrobbler with no entry
// of its own follows `default`, so a plugin installed later starts with the
// same audio/video choice the user made for everything else — and the old
// single `trackVideoHistory` switch, which gated every scrobbler at once,
// migrates into `default.video` without having to know any plugin ids.

/** The built-in scrobbler: the local play history (play counts, ranks,
 *  Recently played / Most played). Plugin manifest ids can't contain `:`, so
 *  no plugin can share this id — the same rule the `core:*` image and info
 *  providers rely on. */
export const LOCAL_HISTORY_SCROBBLER = "core:history";

export interface ScrobbleMedia {
  audio: boolean;
  video: boolean;
}

export interface ScrobbleSettings {
  /** For any scrobbler without its own entry. */
  default: ScrobbleMedia;
  byId: Record<string, ScrobbleMedia>;
}

export const DEFAULT_SCROBBLE_SETTINGS: ScrobbleSettings = {
  default: { audio: true, video: true },
  byId: {},
};

/** What happened when a play crossed the scrobble threshold: `offered` —
 *  at least one scrobbler is on for this media type; `accepted` — at least one
 *  took it (the bar's checkmark). */
export interface ScrobbleOutcome {
  offered: boolean;
  accepted: boolean;
}

export function scrobbleMediaFor(settings: ScrobbleSettings, id: string): ScrobbleMedia {
  // Own keys only: `byId` is a plain object, so an id like `constructor`
  // would otherwise read Object.prototype's.
  return Object.prototype.hasOwnProperty.call(settings.byId, id) ? settings.byId[id] : settings.default;
}

/** Whether scrobbler `id` should record a play of this media type. */
export function scrobblerAccepts(settings: ScrobbleSettings, id: string, isVideo: boolean): boolean {
  const media = scrobbleMediaFor(settings, id);
  return isVideo ? media.video : media.audio;
}

export function withScrobbleMedia(
  settings: ScrobbleSettings,
  id: string,
  patch: Partial<ScrobbleMedia>,
): ScrobbleSettings {
  return {
    ...settings,
    byId: { ...settings.byId, [id]: { ...scrobbleMediaFor(settings, id), ...patch } },
  };
}

/** One switch for video across every scrobbler, known or not yet installed —
 *  what onboarding's "Track video history" offers. */
export function withVideoForAll(settings: ScrobbleSettings, video: boolean): ScrobbleSettings {
  const byId = Object.fromEntries(
    Object.entries(settings.byId).map(([id, media]) => [id, { ...media, video }]),
  );
  return { default: { ...settings.default, video }, byId };
}

/** True when the default and every listed scrobbler record video. Pass the
 *  scrobblers the user can actually see (Settings → Scrobbling's rows): a
 *  `byId` entry left behind by an uninstalled plugin must not turn the
 *  onboarding switch off. */
export function videoOnForAll(settings: ScrobbleSettings, ids: readonly string[]): boolean {
  return settings.default.video && ids.every((id) => scrobbleMediaFor(settings, id).video);
}

function coerceMedia(raw: unknown, fallback: ScrobbleMedia): ScrobbleMedia {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    audio: typeof src.audio === "boolean" ? src.audio : fallback.audio,
    video: typeof src.video === "boolean" ? src.video : fallback.video,
  };
}

/** Read the persisted value defensively. `legacyTrackVideoHistory` is the
 *  pre-settings `trackVideoHistory` key, used only when `scrobbleSettings`
 *  was never written. */
export function coerceScrobbleSettings(raw: unknown, legacyTrackVideoHistory?: unknown): ScrobbleSettings {
  if (raw == null || typeof raw !== "object") {
    const video = typeof legacyTrackVideoHistory === "boolean"
      ? legacyTrackVideoHistory
      : DEFAULT_SCROBBLE_SETTINGS.default.video;
    return { default: { audio: true, video }, byId: {} };
  }
  const src = raw as Record<string, unknown>;
  const def = coerceMedia(src.default, DEFAULT_SCROBBLE_SETTINGS.default);
  // fromEntries defines own properties, so a stored `__proto__` key stays a
  // plain entry instead of re-pointing the object's prototype.
  const byId: Record<string, ScrobbleMedia> = src.byId && typeof src.byId === "object"
    ? Object.fromEntries(
      Object.entries(src.byId as Record<string, unknown>).map(([id, media]) => [id, coerceMedia(media, def)]),
    )
    : {};
  return { default: def, byId };
}

export interface ScrobblerEntry {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
}

/** The Settings → Scrobbling rows: local history first, then each plugin
 *  currently subscribed to `track:scrobbled`, by name. */
export function buildScrobblerList(
  pluginIds: readonly string[],
  plugins: ReadonlyArray<{ id: string; manifest: { name: string; description?: string } }>,
): ScrobblerEntry[] {
  const byId = new Map(plugins.map((p) => [p.id, p.manifest]));
  const fromPlugins = pluginIds
    .map((id) => {
      const manifest = byId.get(id);
      return {
        id,
        name: manifest?.name ?? id,
        description: manifest?.description ?? "",
        builtin: false,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return [
    {
      id: LOCAL_HISTORY_SCROBBLER,
      name: "Local history",
      description: "Play counts, ranks, History and the Most played / Recently played shelves",
      builtin: true,
    },
    ...fromPlugins,
  ];
}
