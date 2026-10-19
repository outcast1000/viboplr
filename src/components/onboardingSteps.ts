import type { DependencyInfo } from "../hooks/useDependencies";

/** Canonical step order. Visibility filters this list; it is never reordered. */
export const ONBOARDING_STEP_ORDER = [
  "profile",
  "welcome",
  "music",
  "plugins",
  "dependencies",
  "spotify",
  "lastfm",
  "playback",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_ORDER)[number];

/**
 * Two ways to use Vibo, Spotify-style: with music of your own, or without any.
 *
 * The ids are the gallery's — `index.json` pre-checks plugins per profile by
 * these strings (`profiles: ["streaming"]`), so they are a wire format, not
 * labels: "normal" stays "normal" even though its card reads "My own music".
 * There used to be four (Local / Video / Streaming / Server). Video and Server
 * were both "my own music" with a different first suggestion, and the music
 * step offers folders and servers side by side anyway, so they folded into
 * "normal" — `normalizeProfile` maps a stored legacy id there.
 */
export const ONBOARDING_PROFILES = ["normal", "streaming"] as const;
export type OnboardingProfile = (typeof ONBOARDING_PROFILES)[number];

/** Coerce a persisted value to a known profile; unknown/absent (incl. the
 *  retired "video" / "server") → "normal". */
export function normalizeProfile(value: unknown): OnboardingProfile {
  return ONBOARDING_PROFILES.includes(value as OnboardingProfile)
    ? (value as OnboardingProfile)
    : "normal";
}

/**
 * Declarative per-profile wizard knobs. All profile-specific behavior lives
 * here so the whole matrix is visible in one place; step components read
 * PROFILE_PRESETS[profile] instead of switching on the id inline.
 */
export interface ProfilePreset {
  /** Card title on the profile step. */
  title: string;
  /** Card one-liner on the profile step. */
  description: string;
  /** The user keeps music of their own. Without it the wizard drops the music
   *  step (a folder picker is the one thing this user came here not to do) and
   *  the playback step: auto-continue draws from the library, which stays
   *  empty, and a step holding only a crossfade slider is a click between this
   *  user and their music. Crossfade stays in Settings → Playback. */
  hasLocalMusic: boolean;
  /** Offer the skin picker. Off for a setup with no music of its own: every
   *  step before the plugins is a step before the first song, and a look is
   *  one click away in Extensions → Skins whenever the user wants it. */
  pickLook: boolean;
  /** Intro copy for the plugins step. */
  pluginsDesc: string;
  /** Continue on the plugins step installs what is checked. For a user with
   *  no music of their own the plugins *are* the music, so walking past them
   *  with Continue — the obvious button — left a player with nothing to play. */
  installPluginsOnContinue: boolean;
  /** The companion-tools step starts installing the tools plugins *require*
   *  by itself (managed downloads only, see `autoInstallableDeps`). Same
   *  reasoning: with no local music those binaries are the only route to sound. */
  autoInstallTools: boolean;
  /**
   * Home shelves this profile switches on, by id. Applied by `HomeView` via
   * `seedProfileShelfVisibility` — only to shelves the user has never set, so
   * it seeds a default rather than overriding a choice.
   *
   * Ids are literals rather than imports from `useHome`: that module pulls in
   * the store and tauri `invoke`, and this file is the wizard's pure-helper
   * module. `profileShelves.test.ts` pins them against the real descriptor
   * list so a renamed shelf can't rot into a silent no-op here.
   *
   * "normal" must stay empty: it is also the profile of every user who never
   * ran the wizard (`normalizeProfile(undefined)`), so a shelf seeded here
   * would be switched on for all of them.
   */
  profileShelves: string[];
}

export const PROFILE_PRESETS: Record<OnboardingProfile, ProfilePreset> = {
  normal: {
    title: "My own music",
    description: "Music and video files on this computer, or your own Subsonic / Navidrome server",
    hasLocalMusic: true,
    pickLook: true,
    pluginsDesc:
      "Plugins add streaming sources, lyrics, artwork, scrobbling and more. Recommended ones are pre-selected — adjust the list and install, or skip for now.",
    installPluginsOnContinue: false,
    autoInstallTools: false,
    profileShelves: [],
  },
  streaming: {
    title: "No collection",
    // Name only what the wizard can actually offer: `filterOnboardingEntries`
    // drops experimental gallery entries (TIDAL, Soulseek…) from the plugins
    // step outright, so naming them here would promise a source that never
    // appears. Keep this in step with what the gallery ships as stable.
    description: "Just search and play — YouTube, SoundCloud and 1000+ other sites, plus your Spotify playlists. No files needed.",
    hasLocalMusic: false,
    pickLook: false,
    pluginsDesc:
      "These plugins are where your music comes from. The ones you need are already selected — Continue installs them. You can add more later from Extensions, or a folder of your own under Collections.",
    installPluginsOnContinue: true,
    autoInstallTools: true,
    // With no library, the library-backed defaults (Recently added, Made for
    // you, Discover by decade, Forgotten favorites, Liked albums — and the
    // Radio carousel, whose seeds are library tracks) are always empty and
    // hide themselves. These two need no library: likes live in the
    // metadata-keyed entity_likes store and history is name-keyed, and an
    // artist card with no library row opens the name-based artist page.
    profileShelves: ["builtin:recently-liked", "builtin:most-played-artists-30d"],
  },
};

/**
 * Home shelf visibility with this profile's shelves switched on — but only for
 * shelves the user has never set either way. Returns `null` when there is
 * nothing to change, so callers can skip the state update entirely.
 *
 * "Only where unset" is the whole contract. The wizard is re-runnable from
 * Settings, and a profile that re-asserted its shelves on every run would
 * silently undo a shelf the user had deliberately switched off. An absent key
 * means "no opinion yet", which is the only case a default may fill.
 */
export function seedProfileShelfVisibility(
  profile: OnboardingProfile,
  visibility: Record<string, boolean>,
): Record<string, boolean> | null {
  const unset = PROFILE_PRESETS[profile].profileShelves.filter(
    (id) => visibility[id] === undefined,
  );
  if (unset.length === 0) return null;
  const next = { ...visibility };
  for (const id of unset) next[id] = true;
  return next;
}

/** "a", "a and b", "a, b and c" — for naming a handful of binaries in prose. */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface OnboardingStepContext {
  /** Missing external binaries needed by enabled plugins (see missingPluginDeps). */
  missingDepNames: string[];
  /** Whether the Last.fm plugin is installed (any status). */
  lastfmInstalled: boolean;
  /** Whether the Spotify plugin is installed and running — the only state in
   *  which it can open its sign-in window. Absent = false. */
  spotifyActive?: boolean;
  /** The usage profile chosen on the first step. */
  profile: OnboardingProfile;
}

export function visibleSteps(ctx: OnboardingStepContext): OnboardingStepId[] {
  return ONBOARDING_STEP_ORDER.filter((id) => {
    if (id === "welcome") return PROFILE_PRESETS[ctx.profile].pickLook;
    if (id === "music") return PROFILE_PRESETS[ctx.profile].hasLocalMusic;
    if (id === "dependencies") return ctx.missingDepNames.length > 0;
    if (id === "spotify") return !!ctx.spotifyActive;
    if (id === "lastfm") return ctx.lastfmInstalled;
    if (id === "playback") return PROFILE_PRESETS[ctx.profile].hasLocalMusic;
    return true;
  });
}

/** The Spotify plugin's gallery / manifest id. */
export const SPOTIFY_PLUGIN_ID = "spotify-browse";

/**
 * Where the Spotify sign-in stands, as the wizard's Spotify step shows it.
 * Read off the plugin's own `status` assistant tool — `{ syncStatus,
 * playlistCount, auth?, account? }` — because that is the one read surface
 * the plugin publishes. `syncStatus` is `idle` / `checking` / `waiting-login`
 * / `running` / `done` / `error`; `checking` (a quiet sync's hidden sign-in
 * check, which its first activation runs) and `auth` / `account` are newer
 * than the rest, so an older plugin build simply never sends them. The
 * plugin signs in by syncing: a visible sync opens open.spotify.com in a
 * window and waits there until the user has signed in.
 */
export type SpotifyConnection =
  | { state: "unknown" }
  | { state: "checking" }
  | { state: "not-connected"; signedOut: boolean }
  | { state: "signing-in" }
  | { state: "loading" }
  | { state: "ready"; playlists: number; account: string | null }
  | { state: "failed" };

export function spotifyConnection(status: unknown): SpotifyConnection {
  if (!status || typeof status !== "object") return { state: "unknown" };
  const s = status as { syncStatus?: unknown; playlistCount?: unknown; auth?: unknown; account?: unknown };
  const playlists = typeof s.playlistCount === "number" && s.playlistCount > 0 ? s.playlistCount : 0;
  const signedIn = s.auth === "signed-in";
  const account = signedIn && typeof s.account === "string" && s.account.trim() ? s.account.trim() : null;
  // Synced playlists, or a confirmed session, both mean there is nothing left
  // for this step to ask for.
  const ready = (): SpotifyConnection => ({ state: "ready", playlists, account });
  switch (s.syncStatus) {
    case "checking":
      return { state: "checking" };
    case "waiting-login":
      return { state: "signing-in" };
    case "running":
      return { state: "loading" };
    case "error":
      // A sync that failed after an earlier one landed still has playlists to
      // show; only a run with nothing to show reads as "didn't work".
      return playlists > 0 ? ready() : { state: "failed" };
    case "idle":
    case "done":
      return playlists > 0 || signedIn ? ready() : { state: "not-connected", signedOut: s.auth === "signed-out" };
    default:
      return { state: "unknown" };
  }
}

/**
 * Companion tools the wizard may install without a click (`autoInstallTools`):
 * missing, offered as a managed download, and *required* by some plugin.
 * Optional tools keep their own button — "this plugin works better with it" is
 * the user's call — and a tool with no managed build can't be fetched anyway.
 * Nor one whose download nothing checks (`verified: false`): that install is
 * confirmed by the user every time, so it keeps its button instead of popping
 * a confirmation in the middle of the wizard.
 */
export function autoInstallableDeps(deps: DependencyInfo[]): string[] {
  return deps
    .filter(
      (d) =>
        d.status !== "installed" &&
        d.managedAvailable &&
        d.verified &&
        d.pluginConsumers.some((c) => c.required),
    )
    .map((d) => d.name);
}

/**
 * Dependencies worth a wizard step: not installed, and needed by at least one
 * enabled plugin (e.g. yt-dlp/ffmpeg after installing the YouTube plugin).
 * Internal-only consumers don't trigger the step — the app works without them
 * and Extensions → Tools covers that case.
 */
export function missingPluginDeps(deps: DependencyInfo[]): string[] {
  return deps
    .filter((d) => d.status !== "installed" && d.pluginConsumers.length > 0)
    .map((d) => d.name);
}

/**
 * Steps to render in the progress indicator. If the current step just became
 * invisible (e.g. its dependency finished installing while the user is on
 * it), keep it in place at its canonical position instead of yanking the UI.
 */
export function stepsForDisplay(
  steps: readonly OnboardingStepId[],
  current: OnboardingStepId,
): OnboardingStepId[] {
  if (steps.includes(current)) return [...steps];
  return ONBOARDING_STEP_ORDER.filter((id) => id === current || steps.includes(id));
}

export function nextStepId(
  current: OnboardingStepId,
  steps: readonly OnboardingStepId[],
): OnboardingStepId | null {
  const start = ONBOARDING_STEP_ORDER.indexOf(current);
  for (let i = start + 1; i < ONBOARDING_STEP_ORDER.length; i++) {
    const id = ONBOARDING_STEP_ORDER[i];
    if (steps.includes(id)) return id;
  }
  return null;
}

export function prevStepId(
  current: OnboardingStepId,
  steps: readonly OnboardingStepId[],
): OnboardingStepId | null {
  const start = ONBOARDING_STEP_ORDER.indexOf(current);
  for (let i = start - 1; i >= 0; i--) {
    const id = ONBOARDING_STEP_ORDER[i];
    if (steps.includes(id)) return id;
  }
  return null;
}

export type OnboardingDecision = "show" | "mark-complete" | "none";

/**
 * First-launch decision, evaluated once after restore. Existing profiles are
 * detected by having collections or the legacy pluginRecommendationsShown
 * flag — those are marked complete silently so only fresh profiles see the
 * wizard.
 */
export function onboardingDecision(opts: {
  onboardingComplete: boolean;
  pluginRecommendationsShown: boolean;
  collectionCount: number;
}): OnboardingDecision {
  if (opts.onboardingComplete) return "none";
  if (opts.pluginRecommendationsShown || opts.collectionCount > 0) return "mark-complete";
  return "show";
}
