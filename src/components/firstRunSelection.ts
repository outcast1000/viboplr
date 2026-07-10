import type { GalleryPluginEntry } from "../types/plugin";
import type { OnboardingProfile } from "./onboardingSteps";
import { isExperimental } from "../utils/pluginStability";

/**
 * Entries the onboarding wizard is allowed to surface: experimental plugins
 * never appear in the wizard regardless of `recommended`/`profiles`. The
 * wizard filters once through this helper so the rendered rows, the initial
 * selection, and the install set can never disagree.
 */
export function filterOnboardingEntries(entries: GalleryPluginEntry[]): GalleryPluginEntry[] {
  return entries.filter((e) => !isExperimental(e.stability));
}

/**
 * IDs that should start checked in the wizard's plugins step: entries whose
 * gallery `profiles` list contains the chosen profile — falling back, for
 * entries without a `profiles` field, to `recommended: true` meaning
 * "recommended for every profile" (back-compat with the pre-profiles index).
 * Installed entries are never pre-checked.
 */
export function computeInitialSelection(
  entries: GalleryPluginEntry[],
  installedIds: Set<string>,
  profile: OnboardingProfile,
): Set<string> {
  const selected = new Set<string>();
  for (const e of entries) {
    if (installedIds.has(e.id)) continue;
    const preChecked = e.profiles ? e.profiles.includes(profile) : e.recommended === true;
    if (preChecked) selected.add(e.id);
  }
  return selected;
}

/**
 * Gallery entries to actually install: checked, not already installed,
 * and installable (has an updateUrl).
 */
export function computeInstallEntries(
  entries: GalleryPluginEntry[],
  checkedIds: Set<string>,
  installedIds: Set<string>,
): GalleryPluginEntry[] {
  return entries.filter(
    (e) => checkedIds.has(e.id) && !installedIds.has(e.id) && !!e.updateUrl,
  );
}
