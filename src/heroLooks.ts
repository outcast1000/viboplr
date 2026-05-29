export type HeroMotion =
  | "current"
  | "focal"
  | "breathe"
  | "push"
  | "sway"
  | "wander";

export type HeroLookId =
  | "worn-tape"
  | "late-night"
  | "silent-film"
  | "signal-lost"
  | "daydream"
  | "broadcast"
  | "channel-surf"
  | "minimal";

export type HeroEffectMode = "disabled" | HeroLookId | "random" | "by-artist";

export interface HeroLayers {
  bleed: boolean;
  bleed2: boolean;
  scan: boolean;
  flicker: boolean;
  track: boolean;
  slice: boolean;
  noise: boolean;
  noise2: boolean;
  vignette: boolean;
  /** B&W background modifier; applied on the hero root, not the overlay. */
  bw: boolean;
}

export interface HeroLook {
  id: HeroLookId;
  label: string;
  motion: HeroMotion;
  layers: HeroLayers;
}

const DEFAULT_MODE: HeroEffectMode = "worn-tape";

function layers(partial: Partial<HeroLayers>): HeroLayers {
  return {
    bleed: false,
    bleed2: false,
    scan: false,
    flicker: false,
    track: false,
    slice: false,
    noise: false,
    noise2: false,
    vignette: false,
    bw: false,
    ...partial,
  };
}

export const LOOKS: HeroLook[] = [
  {
    id: "worn-tape",
    label: "Worn Tape",
    motion: "wander",
    layers: layers({ bleed: true, bleed2: true, scan: true, track: true, noise: true, noise2: true, vignette: true }),
  },
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
    id: "signal-lost",
    label: "Signal Lost",
    motion: "focal",
    layers: layers({ bleed: true, bleed2: true, slice: true, noise: true, vignette: true }),
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
    id: "channel-surf",
    label: "Channel Surf",
    motion: "wander",
    layers: layers({ scan: true, flicker: true, vignette: true }),
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
  if (legacy === true) return "worn-tape";
  if (legacy === false) return "disabled";
  return DEFAULT_MODE;
}

export const HERO_EFFECT_DEFAULT_MODE = DEFAULT_MODE;
