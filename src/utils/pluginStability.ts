// Plugin maturity classification. One shared rule for every consumer
// (gallery grouping, badges, onboarding filter) so the fail-safe direction
// can't drift between call sites.

export type StabilityTier = "stable" | "experimental";

const warnedValues = new Set<string>();

/** Classify a raw `stability` value from a manifest or gallery entry.
 *  Absent / empty / "stable" (trimmed, case-insensitive) → stable.
 *  Everything else — including unknown future values like "beta" — is
 *  experimental-tier: never present an unknown maturity as stable.
 *  `String(...)` guards against non-string JSON values (manifests and the
 *  gallery index are untyped at runtime). */
export function stabilityTier(value?: string | null): StabilityTier {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "" || normalized === "stable") return "stable";
  if (normalized !== "experimental" && !warnedValues.has(normalized)) {
    // The UI never echoes raw values (unknown tiers all render as
    // "Experimental"), so a typo in the index would otherwise be invisible.
    warnedValues.add(normalized);
    console.warn(`Unrecognized plugin stability value "${normalized}" — treating as experimental`);
  }
  return "experimental";
}

export function isExperimental(value?: string | null): boolean {
  return stabilityTier(value) === "experimental";
}

/** Resolve an installed plugin's effective stability value. The manifest wins
 *  when it carries a non-blank value; otherwise the gallery entry fills the
 *  gap (so installed copies get badged before their plugin repos ship the
 *  manifest field). A blank/empty manifest value counts as "lacks the field",
 *  not as an explicit stable claim. Dev checkouts never inherit from the
 *  gallery — the local manifest is the developer's source of truth. */
export function resolveInstalledStability(
  manifestValue: string | undefined,
  galleryValue: string | undefined,
  isDev: boolean,
): string | undefined {
  if (isDev) return manifestValue;
  return String(manifestValue ?? "").trim() !== "" ? manifestValue : galleryValue;
}

/** Split a list into stable and experimental pools (order preserved). */
export function partitionByStability<T extends { stability?: string }>(
  items: T[],
): { stable: T[]; experimental: T[] } {
  const stable: T[] = [];
  const experimental: T[] = [];
  for (const item of items) {
    (isExperimental(item.stability) ? experimental : stable).push(item);
  }
  return { stable, experimental };
}

/** One-line disclaimer shown wherever experimental plugins surface
 *  (gallery section banner, badge tooltips, the site mirrors the wording). */
export const EXPERIMENTAL_DISCLAIMER =
  "Experimental plugins may break, change, or be removed without notice.";
