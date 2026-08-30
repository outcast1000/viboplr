import type { View } from "../types";

/**
 * Parsing for the `viboplr://probe` deep link — the remote control that lets
 * `scripts/perf-probe.mjs --auto` drive the app into each measured scenario
 * without a human at the keyboard.
 *
 * Why a deep link rather than scripted keystrokes: `osascript` keystrokes need
 * the parent terminal granted Accessibility, they land on whatever app is
 * frontmost, and Cmd-M in this app is *mute* (useInAppKeyboardShortcuts, case
 * "m") — scripting it would silently mute the audio whose decode cost the probe
 * is trying to measure. Going through the deep link keeps the whole run to
 * `open` calls with no special permissions.
 *
 * Gated on the profile (see `isProbeProfile`), so the route is inert for real
 * users: a page that opens `viboplr://probe?...` against someone's default
 * profile gets nothing.
 */

/**
 * Views the probe can switch to directly.
 *
 * `artists` / `albums` / `tags` are deliberately absent: those are *detail*
 * views that mean nothing without a selected entity (and this route's view
 * handler clears the selection). Reach them with `artist=` / `album=` / `tag=`
 * instead. `quiz` is absent because `viboplr://quiz` already opens it.
 */
const PROBE_VIEWS = [
  "home",
  "search",
  "history",
  "nowplaying",
  "playlists",
  "collections",
  "extensions",
  "settings",
] as const satisfies readonly View[];

export type ProbeView = (typeof PROBE_VIEWS)[number];

export interface ProbeCommand {
  /** Switch the main view. */
  view?: ProbeView;
  /** Enter (`true`) or leave (`false`) the mini player. */
  mini?: boolean;
  /** Miniaturize (`"minimize"`) or restore (`"restore"`) the window. */
  window?: "minimize" | "restore";
  /** Resume (`true`) or pause (`false`) transport. */
  play?: boolean;
  /**
   * Write a state dump to `probe-dump.json` in the profile directory.
   *
   * There is deliberately **no path parameter**: a URL that names its own
   * destination is a write-anywhere primitive, and the profile gate is the only
   * thing standing in front of it. A fixed filename in a directory the backend
   * already owns removes that surface entirely, and the caller can compute the
   * location (see `scripts/lib/appSmoke.mjs` → `probeDumpPath`).
   */
  dump?: boolean;
  /**
   * Absolute path to a media file or folder to resolve and play immediately.
   *
   * Unlike `dump` this takes a path from the URL, and the asymmetry is
   * deliberate: `dump` *writes*, so naming its own destination would be a
   * write-anywhere primitive; this only *reads* a file the user already has and
   * plays it. Behind the same profile gate, the worst outcome is a perf profile
   * playing a sound. Resolution reuses `resolve_dropped_paths` — the same
   * command the Finder drag-and-drop path uses — so folders, tag reading and
   * the media filter all behave exactly as they do for a real drop.
   */
  open?: string;
  /**
   * Restrict what `open` plays to one media kind.
   *
   * Exists because a folder is the only practical way to seed a queue, and
   * `resolve_dropped_paths` accepts every supported media type — so a single
   * stray video sorts to the front and every "playing audio" measurement
   * silently becomes a video-decode measurement. That is not hypothetical: it
   * invalidated a whole recorded run.
   */
  openKind?: "audio" | "video";
  /**
   * Flush pending state and exit.
   *
   * Better than `osascript -e 'quit app'` for an unattended harness on both
   * counts that matter: an open modal can swallow Cmd-Q, and the store's writes
   * are debounced 500ms, so a quit landing inside that window can drop the very
   * queue the next run replays.
   */
  quit?: boolean;
  /**
   * Open an entity detail page by name. Routed through `useLibrary`'s
   * `navigateTo*ByName`, so an entity not yet in the loaded list still resolves
   * via its `find_*_by_name` fallback — the same path plugins navigate by.
   *
   * These are the surfaces that mount `DetailHeroEffect`, whose look stacks ~9
   * infinite animations (including a tiled `background-position` repaint several
   * times a second). Without a way to reach them the probe could not measure the
   * most animation-heavy screen in the app.
   */
  entity?: { kind: "artist" | "album" | "tag"; name: string; artistName?: string };
  /**
   * Enter (`true`) or leave (`false`) fullscreen for the current track.
   *
   * Dispatches through App's `toggleFullscreenForTrack`, so audio gets the
   * `AudioFullscreen` overlay and video gets its own path — the probe does not
   * re-derive that branch. No-op with nothing playing (`canFullscreen`).
   */
  fullscreen?: boolean;
  /**
   * Dismiss the first-run wizard, persisting the same flags its own close
   * handler does. A fresh profile shows the wizard over everything, so without
   * this every scenario samples the wizard.
   */
  dismissOnboarding?: boolean;
  /**
   * Add a local folder as a collection and start its scan.
   *
   * This is the one verb that mutates the library, and it is allowed only
   * because of what it is gated to: a `perf` profile is a disposable harness
   * profile with no real library to damage, and the same gate already lets
   * `open=` play arbitrary local files. The alternative — a setup script writing
   * the profile's `app-state.json` behind the running app's back — duplicates
   * the store schema, races the app's own debounced flush, and cannot reach the
   * database at all. `collection-sync` remains deliberately undrivable: that
   * scenario would mutate on every *measurement*, not once during setup.
   */
  addCollection?: string;
}

/**
 * Only profiles named `perf` or `perf-<something>` honour the probe route. The
 * probe launches the app with `--profile perf`; every other profile — including
 * `default` — ignores the link entirely.
 *
 * Case-insensitive, and must stay so: `canonical_profile_name` (profiles.rs)
 * resolves a launch-time name to an *existing directory's* casing, so an app
 * started as `--profile perf` against a `Perf/` directory reports `Perf`. Kept
 * in step with `profiles::is_probe_profile`, which gates the dump file write.
 */
export function isProbeProfile(profileName: string | null | undefined): boolean {
  if (!profileName) return false;
  const lower = profileName.toLowerCase();
  return lower === "perf" || lower.startsWith("perf-");
}

/** One phase of startup, as recorded by `timing.rs` / `startupTiming.ts`. */
export interface ProbeTimingEntry {
  label: string;
  duration_ms: number;
  offset_ms: number;
}

export interface ProbeDumpInput {
  appVersion: string;
  profile: string;
  os: string;
  arch: string;
  trackCount: number | null;
  /**
   * What this profile actually has, so a harness can configure itself instead
   * of being told. Without it `--artist` / `--video` are values a human has to
   * know and type, which is not much of an autonomous run.
   */
  artistNames: string[];
  queueLength: number;
  view: string;
  playing: boolean;
  miniMode: boolean;
  fullscreen: boolean;
  currentTrack: string | null;
  backendTimings: ProbeTimingEntry[];
  frontendTimings: ProbeTimingEntry[];
  capturedAt: string;
}

/** Bump when the shape changes so a reader can refuse an unknown dump. */
export const PROBE_DUMP_SCHEMA = 2;

/** How many artist names a dump carries — enough to pick one, not a catalog. */
export const CATALOG_SAMPLE = 5;

/**
 * Wall-clock span covered by one side's timing entries: the furthest point any
 * phase reached, not the sum of the phases (which double-counts anything
 * concurrent).
 */
export function timingSpanMs(entries: ProbeTimingEntry[]): number {
  let max = 0;
  for (const e of entries) {
    const end = e.offset_ms + e.duration_ms;
    if (Number.isFinite(end) && end > max) max = end;
  }
  return max;
}

/**
 * Assemble the state dump. Pure, so the shape the smoke test asserts against is
 * testable without a running app.
 *
 * **The two spans are reported separately and must not be added.** The backend
 * timer's origin is process start (`init_timer()` in `run()`); the frontend's is
 * the moment `startupTiming.ts` is evaluated, which happens somewhere inside the
 * backend's span once the webview loads. They are two clocks with no shared
 * zero, so a combined "total startup" would be a number that reads as
 * authoritative and means nothing.
 */
export function buildProbeDump(input: ProbeDumpInput) {
  return {
    schema: PROBE_DUMP_SCHEMA,
    capturedAt: input.capturedAt,
    app: {
      version: input.appVersion,
      profile: input.profile,
      os: input.os,
      arch: input.arch,
    },
    library: {
      trackCount: input.trackCount,
      // Capped: the harness only needs a name to navigate to, and a dump is
      // read by a script and pasted into issues — a 5000-artist list helps
      // nobody and makes the file unreadable.
      artistNames: input.artistNames.slice(0, CATALOG_SAMPLE),
      queueLength: input.queueLength,
    },
    ui: {
      view: input.view,
      playing: input.playing,
      miniMode: input.miniMode,
      fullscreen: input.fullscreen,
      currentTrack: input.currentTrack,
    },
    startup: {
      backendSpanMs: timingSpanMs(input.backendTimings),
      frontendSpanMs: timingSpanMs(input.frontendTimings),
      backend: input.backendTimings,
      frontend: input.frontendTimings,
    },
  };
}

/** `"on"`/`"off"` (and the usual synonyms) → boolean; anything else → undefined. */
function parseFlag(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "on" || v === "1" || v === "true" || v === "yes") return true;
  if (v === "off" || v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

/**
 * Parse a `viboplr://probe?...` URL into the actions it requests.
 *
 * Returns `null` when `raw` is not a probe link at all, so the caller can fall
 * through to the other deep-link routes. Returns an *empty* object for a probe
 * link carrying no recognised parameter — that is a well-formed no-op, not a
 * miss, and must not be forwarded to plugins.
 */
export function parseProbeCommand(raw: string): ProbeCommand | null {
  if (!/^viboplr:\/\/probe(\/)?(\?|$)/i.test(raw)) return null;

  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
  const params = new URLSearchParams(query);
  const cmd: ProbeCommand = {};

  const view = params.get("view")?.trim().toLowerCase();
  if (view && (PROBE_VIEWS as readonly string[]).includes(view)) {
    cmd.view = view as ProbeView;
  }

  const mini = parseFlag(params.get("mini"));
  if (mini !== undefined) cmd.mini = mini;

  const play = parseFlag(params.get("play"));
  if (play !== undefined) cmd.play = play;

  const dump = parseFlag(params.get("dump"));
  if (dump !== undefined) cmd.dump = dump;

  const quit = parseFlag(params.get("quit"));
  if (quit !== undefined) cmd.quit = quit;

  const fullscreen = parseFlag(params.get("fullscreen"));
  if (fullscreen !== undefined) cmd.fullscreen = fullscreen;

  if (params.get("onboarding")?.trim().toLowerCase() === "dismiss") {
    cmd.dismissOnboarding = true;
  }

  // Absolute only, same reasoning as `open`.
  const collection = params.get("collection")?.trim();
  if (collection && collection.startsWith("/")) cmd.addCollection = collection;

  // Fixed precedence when several are given, rather than "whichever the URL
  // happened to list first" — one link can only land on one detail page.
  const artist = params.get("artist")?.trim();
  const album = params.get("album")?.trim();
  const tag = params.get("tag")?.trim();
  if (artist) {
    cmd.entity = { kind: "artist", name: artist };
  } else if (album) {
    const artistName = params.get("albumArtist")?.trim();
    cmd.entity = { kind: "album", name: album, ...(artistName ? { artistName } : {}) };
  } else if (tag) {
    cmd.entity = { kind: "tag", name: tag };
  }

  // Absolute only: a relative path has no meaningful base here (the app's cwd
  // is wherever launchd started it), so accepting one would resolve somewhere
  // nobody intended. `file://` is tolerated because the backend strips it too.
  const open = params.get("open")?.trim();
  if (open && (open.startsWith("/") || open.startsWith("file:///"))) cmd.open = open;

  const openKind = params.get("openKind")?.trim().toLowerCase();
  if (openKind === "audio" || openKind === "video") cmd.openKind = openKind;

  const win = params.get("window")?.trim().toLowerCase();
  if (win === "minimize" || win === "restore") cmd.window = win;

  return cmd;
}
