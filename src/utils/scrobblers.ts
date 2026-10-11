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
// The exception is a plugin that declares `contributes.scrobbler.
// defaultEnabled: false` (one that sends plays to a server): it starts off
// until the user turns it on here (`ScrobbleDefaults`).
//
// What happened to each scrobbler's last play is `ScrobblerStatuses`
// (store key `scrobblerStatus`), shown under its row.

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
 *  took it (the bar's checkmark), as far as is known right away. `settled`
 *  resolves with the real answer once every scrobbler has reported, so the
 *  checkmark can follow what actually happened. */
export interface ScrobbleOutcome {
  offered: boolean;
  accepted: boolean;
  settled?: Promise<boolean>;
}

/** Per-scrobbler starting values for scrobblers with no entry of their own,
 *  overriding `default`. Built from manifests by `scrobbleDefaultsFromPlugins`. */
export type ScrobbleDefaults = Readonly<Record<string, ScrobbleMedia>>;

const OFF: ScrobbleMedia = { audio: false, video: false };

function ownEntry<T>(record: Readonly<Record<string, T>> | undefined, id: string): T | undefined {
  // Own keys only: these are plain objects, so an id like `constructor`
  // would otherwise read Object.prototype's.
  return record && Object.prototype.hasOwnProperty.call(record, id) ? record[id] : undefined;
}

export function scrobbleMediaFor(settings: ScrobbleSettings, id: string, defaults?: ScrobbleDefaults): ScrobbleMedia {
  return ownEntry(settings.byId, id) ?? ownEntry(defaults, id) ?? settings.default;
}

/** Whether scrobbler `id` should record a play of this media type. */
export function scrobblerAccepts(settings: ScrobbleSettings, id: string, isVideo: boolean, defaults?: ScrobbleDefaults): boolean {
  const media = scrobbleMediaFor(settings, id, defaults);
  return isVideo ? media.video : media.audio;
}

export function withScrobbleMedia(
  settings: ScrobbleSettings,
  id: string,
  patch: Partial<ScrobbleMedia>,
  defaults?: ScrobbleDefaults,
): ScrobbleSettings {
  return {
    ...settings,
    byId: { ...settings.byId, [id]: { ...scrobbleMediaFor(settings, id, defaults), ...patch } },
  };
}

/** The plugins that start switched off: those whose manifest says
 *  `contributes.scrobbler.defaultEnabled: false`. */
export function scrobbleDefaultsFromPlugins(
  plugins: ReadonlyArray<{ id: string; manifest: { contributes?: { scrobbler?: { defaultEnabled?: boolean } } } }>,
): ScrobbleDefaults {
  const out: Record<string, ScrobbleMedia> = {};
  for (const p of plugins) {
    if (p.manifest.contributes?.scrobbler?.defaultEnabled === false) out[p.id] = OFF;
  }
  return out;
}

/** One switch for video across every scrobbler, known or not yet installed —
 *  what onboarding's "Track video history" offers. A scrobbler that starts
 *  off (`ScrobbleDefaults`) and was never turned on stays off: video history
 *  is not consent to send plays to a server. */
export function withVideoForAll(settings: ScrobbleSettings, video: boolean): ScrobbleSettings {
  const byId = Object.fromEntries(
    Object.entries(settings.byId).map(([id, media]) => [id, { ...media, video }]),
  );
  return { default: { ...settings.default, video }, byId };
}

/** True when the default and every listed scrobbler in use records video. Pass
 *  the scrobblers the user can actually see (Settings → Scrobbling's rows): a
 *  `byId` entry left behind by an uninstalled plugin must not turn the
 *  onboarding switch off. A scrobbler that is off for both media types is not
 *  in use, so a plugin that starts off doesn't read the switch as off either. */
export function videoOnForAll(settings: ScrobbleSettings, ids: readonly string[], defaults?: ScrobbleDefaults): boolean {
  return settings.default.video && ids.every((id) => {
    const media = scrobbleMediaFor(settings, id, defaults);
    return media.video || !media.audio;
  });
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

// ── Last attempt per scrobbler ───────────────────────────────────────────

/** What a scrobbler says happened to a play: `sent` — it reached its
 *  destination; `queued` — kept to send later (offline, batching); `skipped`
 *  — deliberately not sent (signed out, nothing to send it to); `failed` —
 *  tried and it went wrong. A plugin returns one from its `track:scrobbled`
 *  handler and/or reports later with `api.playback.reportScrobble`. */
export type ScrobbleReportStatus = "sent" | "queued" | "skipped" | "failed";

export interface ScrobbleReport {
  status: ScrobbleReportStatus;
  /** Plain text for the user, at most `SCROBBLE_MESSAGE_MAX` chars. */
  message?: string;
  /** Plays still waiting to be sent, when the scrobbler keeps a queue. */
  pending?: number;
}

/** A report, plus `delivered`: the plugin's handler ran and it reported
 *  nothing, so all the host knows is that the play was handed over. */
export type ScrobblerStatusKind = ScrobbleReportStatus | "delivered";

export interface ScrobblerStatus {
  status: ScrobblerStatusKind;
  /** When this was recorded, ms since the epoch. */
  at: number;
  title?: string;
  artist?: string;
  message?: string;
  pending?: number;
}

export type ScrobblerStatuses = Record<string, ScrobblerStatus>;

const REPORT_STATUSES: readonly ScrobbleReportStatus[] = ["sent", "queued", "skipped", "failed"];
const STATUS_KINDS: readonly ScrobblerStatusKind[] = [...REPORT_STATUSES, "delivered"];
export const SCROBBLE_MESSAGE_MAX = 200;

function cleanMessage(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > SCROBBLE_MESSAGE_MAX ? text.slice(0, SCROBBLE_MESSAGE_MAX - 1) + "…" : text;
}

function cleanPending(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : undefined;
}

/** A plugin's report, or null when `raw` isn't one (a handler that returns
 *  nothing, or something else). Unknown fields are dropped. */
export function coerceScrobbleReport(raw: unknown): ScrobbleReport | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  if (!REPORT_STATUSES.includes(src.status as ScrobbleReportStatus)) return null;
  const report: ScrobbleReport = { status: src.status as ScrobbleReportStatus };
  const message = cleanMessage(src.message);
  if (message) report.message = message;
  const pending = cleanPending(src.pending);
  if (pending !== undefined) report.pending = pending;
  return report;
}

/** Whether this outcome counts as the scrobbler having taken the play (the
 *  bar's checkmark). */
export function statusAccepts(status: ScrobblerStatusKind): boolean {
  return status === "sent" || status === "queued" || status === "delivered";
}

/** Record a report for `id`. `track` names the play it is about; a report
 *  without one (a queued batch landing later) keeps the play last recorded. */
export function withScrobblerStatus(
  statuses: ScrobblerStatuses,
  id: string,
  report: { status: ScrobblerStatusKind; message?: string; pending?: number },
  track: { title?: string; artist?: string } | null,
  now: number,
): ScrobblerStatuses {
  const prev = ownEntry(statuses, id);
  const next: ScrobblerStatus = { status: report.status, at: now };
  const title = track ? track.title : prev?.title;
  const artist = track ? track.artist : prev?.artist;
  if (title) next.title = title;
  if (artist) next.artist = artist;
  if (report.message) next.message = report.message;
  if (report.pending !== undefined) next.pending = report.pending;
  return { ...statuses, [id]: next };
}

/** Read the persisted value defensively, entry by entry. */
export function coerceScrobblerStatuses(raw: unknown): ScrobblerStatuses {
  if (!raw || typeof raw !== "object") return {};
  const entries: [string, ScrobblerStatus][] = [];
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const src = value as Record<string, unknown>;
    if (!STATUS_KINDS.includes(src.status as ScrobblerStatusKind)) continue;
    if (typeof src.at !== "number" || !Number.isFinite(src.at)) continue;
    const status: ScrobblerStatus = { status: src.status as ScrobblerStatusKind, at: src.at };
    if (typeof src.title === "string" && src.title) status.title = src.title;
    if (typeof src.artist === "string" && src.artist) status.artist = src.artist;
    const message = cleanMessage(src.message);
    if (message) status.message = message;
    const pending = cleanPending(src.pending);
    if (pending !== undefined) status.pending = pending;
    entries.push([id, status]);
  }
  // fromEntries: a stored `__proto__` id stays a plain entry.
  return Object.fromEntries(entries);
}

export function scrobblerStatusFor(statuses: ScrobblerStatuses, id: string): ScrobblerStatus | undefined {
  return ownEntry(statuses, id);
}

/** What one plugin did with a play, from its `track:scrobbled` handler's
 *  answer (`value`, possibly a promise — a worker plugin's always is — or the
 *  `error` it threw): its returned report, a failure, or else "handed over".
 *  A bare return must not hide a report the plugin made itself while the
 *  handler ran (`reportScrobble`, newer than `dispatchedAt`), so that one
 *  stands. Resolves with whether the plugin took the play; never rejects. */
export function settleScrobbleResult(
  result: { value?: unknown; error?: unknown },
  deps: {
    dispatchedAt: number;
    current: () => ScrobblerStatus | undefined;
    record: (report: { status: ScrobblerStatusKind; message?: string; pending?: number }) => void;
    describeError: (e: unknown) => string;
  },
): Promise<boolean> {
  const fail = (e: unknown) => {
    console.error("Scrobbler failed to take the play:", e);
    deps.record({ status: "failed", message: cleanMessage(deps.describeError(e)) });
    return false;
  };
  if ("error" in result) return Promise.resolve(fail(result.error));
  return Promise.resolve(result.value).then((value) => {
    const report = coerceScrobbleReport(value);
    if (report) {
      deps.record(report);
      return statusAccepts(report.status);
    }
    const reported = deps.current();
    if (reported && reported.at >= deps.dispatchedAt) return statusAccepts(reported.status);
    deps.record({ status: "delivered" });
    return true;
  }, fail);
}

export type ScrobblerStatusTone = "success" | "warning" | "error" | "muted";

/** The line under a scrobbler's row in Settings → Scrobbling. */
export function describeScrobblerStatus(
  status: ScrobblerStatus | undefined,
  ago: (thenMs: number) => string,
): { tone: ScrobblerStatusTone; text: string } {
  if (!status) return { tone: "muted", text: "No plays yet" };
  const song = status.title
    ? `“${status.title}”${status.artist ? ` – ${status.artist}` : ""}`
    : "the last play";
  const when = ago(status.at);
  const waiting = status.pending
    ? ` · ${status.pending} ${status.pending === 1 ? "play" : "plays"} waiting to send`
    : "";
  switch (status.status) {
    case "sent":
      return { tone: "success", text: `Sent ${song} · ${when}${waiting}` };
    case "delivered":
      return { tone: "muted", text: `Handed ${song} to the plugin · ${when}` };
    case "queued":
      return { tone: "warning", text: `Queued ${song} · ${when}${waiting}${status.message ? ` · ${status.message}` : ""}` };
    case "skipped":
      return { tone: "warning", text: `Not sent: ${status.message ?? "the plugin didn't send it"} · ${when}` };
    case "failed":
      return { tone: "error", text: `Failed to send ${song}: ${status.message ?? "unknown error"} · ${when}${waiting}` };
  }
}
