export type HeroMotion =
  | "current"
  | "focal"
  | "breathe"
  | "push"
  | "sway";

export type HeroLookId =
  | "late-night"
  | "silent-film"
  | "daydream"
  | "broadcast"
  | "aurora-drift"
  | "light-leak"
  | "prism-bloom"
  | "minimal";

export type HeroEffectMode = "disabled" | HeroLookId | "random" | "by-artist";

export interface HeroLayers {
  bleed: boolean;
  bleed2: boolean;
  scan: boolean;
  flicker: boolean;
  track: boolean;
  noise: boolean;
  vignette: boolean;
  /** B&W background modifier; applied on the hero root, not the overlay. */
  bw: boolean;
  // --- new aesthetic-family layers ---
  auroraA: boolean;
  auroraB: boolean;
  leakWarm: boolean;
  leakCorner: boolean;
  bloom: boolean;
  fringe: boolean;
}

export interface HeroLook {
  id: HeroLookId;
  label: string;
  motion: HeroMotion;
  layers: HeroLayers;
}

const DEFAULT_MODE: HeroEffectMode = "by-artist";

function layers(partial: Partial<HeroLayers>): HeroLayers {
  return {
    bleed: false,
    bleed2: false,
    scan: false,
    flicker: false,
    track: false,
    noise: false,
    vignette: false,
    bw: false,
    auroraA: false,
    auroraB: false,
    leakWarm: false,
    leakCorner: false,
    bloom: false,
    fringe: false,
    ...partial,
  };
}

export const LOOKS: HeroLook[] = [
  {
    id: "late-night",
    label: "Late Night TV",
    motion: "breathe",
    layers: layers({ scan: true, flicker: true, vignette: true }),
  },
  {
    id: "silent-film",
    label: "Silent Film",
    motion: "push",
    layers: layers({ scan: true, flicker: true, noise: true, vignette: true, bw: true }),
  },
  {
    id: "daydream",
    label: "Daydream",
    motion: "sway",
    layers: layers({ noise: true, vignette: true }),
  },
  {
    id: "broadcast",
    label: "Broadcast",
    motion: "push",
    layers: layers({ bleed: true, bleed2: true, scan: true, track: true, noise: true, vignette: true }),
  },
  {
    id: "aurora-drift",
    label: "Aurora Drift",
    motion: "sway",
    layers: layers({ auroraA: true, auroraB: true, vignette: true }),
  },
  {
    id: "light-leak",
    label: "Light Leak",
    motion: "breathe",
    layers: layers({ leakWarm: true, leakCorner: true, vignette: true }),
  },
  {
    id: "prism-bloom",
    label: "Prism Bloom",
    motion: "focal",
    layers: layers({ bloom: true, fringe: true, vignette: true }),
  },
  {
    id: "minimal",
    label: "Minimal",
    motion: "current",
    layers: layers({}),
  },
];

export const LOOK_IDS: HeroLookId[] = LOOKS.map((l) => l.id);

const LOOK_BY_ID: Record<HeroLookId, HeroLook> = Object.fromEntries(
  LOOKS.map((l) => [l.id, l]),
) as Record<HeroLookId, HeroLook>;

export function getLook(id: HeroLookId): HeroLook {
  return LOOK_BY_ID[id];
}

/** True when the look renders at least one overlay layer (everything except bw, which is a bg modifier). */
export function hasOverlayLayers(look: HeroLook): boolean {
  const { bw: _bw, ...overlay } = look.layers;
  return Object.values(overlay).some(Boolean);
}

export const EFFECT_MODE_OPTIONS: { value: HeroEffectMode; label: string }[] = [
  { value: "disabled", label: "Disabled" },
  ...LOOKS.map((l) => ({ value: l.id as HeroEffectMode, label: l.label })),
  { value: "random", label: "Random" },
  { value: "by-artist", label: "By artist" },
];

const VALID_MODES = new Set<string>(EFFECT_MODE_OPTIONS.map((o) => o.value));

export function isValidMode(v: unknown): v is HeroEffectMode {
  return typeof v === "string" && VALID_MODES.has(v);
}

/** Small stable string hash (djb2-ish), always a non-negative integer. */
export function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Resolve the effect mode to a concrete look id, or null for "disabled".
 * - random: picks a look from `roll` (0..1), never disabled.
 * - by-artist: deterministic from `name`, never disabled. `roll` is ignored.
 */
export function resolveHeroLook(
  mode: HeroEffectMode,
  name: string,
  roll: number,
): HeroLookId | null {
  if (mode === "disabled") return null;
  if (mode === "random") {
    // Clamp to [0, 0.999999] so floor(clamped * length) never reaches length.
    const clamped = roll < 0 ? 0 : roll >= 1 ? 0.999999 : roll;
    return LOOK_IDS[Math.floor(clamped * LOOK_IDS.length)];
  }
  if (mode === "by-artist") {
    return LOOK_IDS[hashString(name) % LOOK_IDS.length];
  }
  return mode; // a HeroLookId
}

/**
 * Resolve the persisted preference, migrating the legacy boolean.
 * Precedence: valid stored mode string > legacy boolean > default.
 */
export function coerceEffectMode(stored: unknown, legacy: unknown): HeroEffectMode {
  if (isValidMode(stored)) return stored;
  // Migrate the legacy boolean (true -> by-artist [the new default], false -> disabled).
  if (legacy === true) return "by-artist";
  if (legacy === false) return "disabled";
  return DEFAULT_MODE;
}

export const HERO_EFFECT_DEFAULT_MODE = DEFAULT_MODE;
