import type { DependencyInfo } from "../hooks/useDependencies";

/** Canonical step order. Visibility filters this list; it is never reordered. */
export const ONBOARDING_STEP_ORDER = [
  "welcome",
  "music",
  "plugins",
  "dependencies",
  "lastfm",
  "playback",
  "finish",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_ORDER)[number];

export interface OnboardingStepContext {
  /** Missing external binaries needed by enabled plugins (see missingPluginDeps). */
  missingDepNames: string[];
  /** Whether the Last.fm plugin is installed (any status). */
  lastfmInstalled: boolean;
}

export function visibleSteps(ctx: OnboardingStepContext): OnboardingStepId[] {
  return ONBOARDING_STEP_ORDER.filter((id) => {
    if (id === "dependencies") return ctx.missingDepNames.length > 0;
    if (id === "lastfm") return ctx.lastfmInstalled;
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
