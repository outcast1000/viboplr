import type { DependencyInfo } from "../hooks/useDependencies";

/** Canonical step order. Visibility filters this list; it is never reordered. */
export const ONBOARDING_STEP_ORDER = [
  "profile",
  "welcome",
  "music",
  "plugins",
  "dependencies",
  "lastfm",
  "playback",
  "finish",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_ORDER)[number];

export const ONBOARDING_PROFILES = ["normal", "video", "streaming", "server"] as const;
export type OnboardingProfile = (typeof ONBOARDING_PROFILES)[number];

/** Coerce a persisted value to a known profile; unknown/absent → "normal". */
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
  /** Intro copy for the music-sources step. */
  musicDesc: string;
  /** List the Subsonic option first on the music step. */
  subsonicFirst: boolean;
  /** Auto-expand the Subsonic connect form on the music step. */
  subsonicAutoExpand: boolean;
  /** Show the "Track video history" row on the playback step. */
  showVideoHistoryToggle: boolean;
}

export const PROFILE_PRESETS: Record<OnboardingProfile, ProfilePreset> = {
  normal: {
    title: "Local music",
    description: "Play music files from folders on this computer",
    musicDesc:
      "Where does your music live? Add a folder or connect a server — scanning runs in the background while you continue. You can add more sources later under Collections.",
    subsonicFirst: false,
    subsonicAutoExpand: false,
    showVideoHistoryToggle: false,
  },
  video: {
    title: "Video collection",
    description: "Music videos and concert files, side by side with audio",
    musicDesc:
      "Where do your videos live? Add a folder — video files are scanned right alongside audio. You can add more sources later under Collections.",
    subsonicFirst: false,
    subsonicAutoExpand: false,
    showVideoHistoryToggle: true,
  },
  streaming: {
    title: "Streaming",
    description: "Play from Spotify, TIDAL and YouTube — no local files required",
    musicDesc:
      "Streaming plugins are set up in the next step — adding a local source here is optional. You can always add folders or servers later under Collections.",
    subsonicFirst: false,
    subsonicAutoExpand: false,
    showVideoHistoryToggle: false,
  },
  server: {
    title: "Music server",
    description: "Stream from your Subsonic or Navidrome server",
    musicDesc:
      "Connect your server — syncing runs in the background while you continue. You can add more sources later under Collections.",
    subsonicFirst: true,
    subsonicAutoExpand: true,
    showVideoHistoryToggle: false,
  },
};

export interface OnboardingStepContext {
  /** Missing external binaries needed by enabled plugins (see missingPluginDeps). */
  missingDepNames: string[];
  /** Whether the Last.fm plugin is installed (any status). */
  lastfmInstalled: boolean;
  /** The usage profile chosen on the first step. */
  profile: OnboardingProfile;
}

export function visibleSteps(ctx: OnboardingStepContext): OnboardingStepId[] {
  return ONBOARDING_STEP_ORDER.filter((id) => {
    if (id === "dependencies") return ctx.missingDepNames.length > 0;
    // Scrobbling is music-centric — the video profile skips the pitch.
    if (id === "lastfm") return ctx.lastfmInstalled && ctx.profile !== "video";
    return true;
  });
}

/**
 * Dependencies worth a wizard step: not installed, and needed by at least one
 * enabled plugin (e.g. yt-dlp/ffmpeg after installing the YouTube plugin).
 * Internal-only consumers don't trigger the step — the app works without them
 * and Settings > Dependencies covers that case.
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
