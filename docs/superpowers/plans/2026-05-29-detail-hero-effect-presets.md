# Detail Hero Effect Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hero effect's on/off checkbox with an 11-option dropdown (Disabled + 8 named motion×effect looks + Random + By-artist), backed by a persisted string preference with migration from the old boolean.

**Architecture:** A new pure module (`heroLooks.ts`) holds the look definitions, a string hash, and a pure `resolveHeroLook(mode, name, roll)` resolver. The boolean preference store becomes a string mode store (`heroEffectMode.ts`) with one-time boolean→string migration. `DetailHero` reads the mode, computes a per-mount random roll, resolves a look, applies a motion class (and B&W modifier) on the `.detail-hero` root, and passes the look to `DetailHeroEffect`, which renders that look's FX layers (or nothing). Motion moves from the base `.detail-hero-bg` rule onto root-scoped motion classes so "Disabled" returns to the original static `inset:0` background.

**Tech Stack:** React 19 + TypeScript, Vite, CSS (skin custom properties), `@tauri-apps/plugin-store` (via `src/store.ts`), Vitest + @testing-library/react (jsdom).

---

## Design Notes (read before starting)

**This extends an already-implemented feature.** The single VHS effect + on/off checkbox is live (commits through `79b9e79`). Files in play and their current state:
- `src/heroTvEffect.ts` — boolean external store (`useSyncExternalStore`), key `"heroTvEffect"`, default `true`. **Becomes** `src/heroEffectMode.ts` (string mode + migration).
- `src/components/DetailHeroEffect.tsx` + `.css` — renders the VHS layers; `active: boolean` prop; has `shouldPauseEffect()` + IntersectionObserver/visibilitychange pause + reduced-motion fallback. **Becomes** look-driven (`look` prop).
- `src/components/DetailHero.tsx` — mounts the overlay + checkbox. **Becomes** a `<select>` + look resolution.
- `src/components/DetailHero.css` — Ken Burns on `.detail-hero-bg`, z-order, toggle styles. **Motion moves to root-scoped motion classes; toggle → select.**
- `src/store.ts` — `heroTvEffect: true`. **Becomes** `heroEffectMode: "worn-tape"`.
- `src/assets/tv-noise.png` — reused as-is.

**Motion-via-root-class decision.** Today the Ken Burns animation is on the bare `.detail-hero-bg` rule, and the element also carries `inset:-8%` (oversize to hide drift edges). For the multi-look design, motion must be per-look and **absent** for Disabled (static `inset:0`). The `.detail-hero-bg` element is rendered inside `DetailHeroBackground` and its class is partly supplied by callers via `bgClassName`, so we do NOT thread motion through there. Instead `DetailHero` (which owns the `<div className="detail-hero">` root) adds a motion class to that root, and CSS targets the child: `.detail-hero.hero-motion-wander .detail-hero-bg { … }`. The base `.detail-hero-bg` rule reverts to the original static `inset:0; z-index:0;`. Disabled → no motion class on the root → static original background, exactly the pre-feature baseline.

**Decoupling note (glitch slice).** The brainstorm glitch preview sampled the artwork in its slice band. To keep `DetailHeroEffect` decoupled from the hero art (it currently knows nothing about the image), the `tv-slice` layer is a bright translucent band (screen blend), not an image sample. It still reads as a jumping glitch slice. Plumbing the real art in is a possible later enhancement, intentionally out of scope.

**Look → layers source of truth.** Which layer `<div>`s a look renders is decided by booleans in `heroLooks.ts` (testable). Per-look *intensities/colours* live in look-scoped CSS classes (`.look-<id> .tv-noise { … }`), not inline magic numbers.

### The 8 looks (motion × layers)

| id | label | motion | bleed | scan | flicker | track | slice | noise | noise2 | vignette | bw |
|---|---|---|---|---|---|---|---|---|---|---|---|
| worn-tape | Worn Tape | wander | ✓ | ✓ | | ✓ | | ✓ | ✓ | ✓ | |
| late-night | Late Night TV | breathe | | ✓ | ✓ | | | | | ✓ | |
| silent-film | Silent Film | push | | ✓ | ✓ | | | ✓ | | ✓ | ✓ |
| signal-lost | Signal Lost | focal | ✓ | | | | ✓ | ✓ | | ✓ | |
| daydream | Daydream | sway | | | | | | ✓ | | ✓ | |
| broadcast | Broadcast | push | ✓ | ✓ | | ✓ | | ✓ | | ✓ | |
| channel-surf | Channel Surf | wander | | ✓ | ✓ | | | | | ✓ | |
| minimal | Minimal | current | | | | | | | | | |

`minimal` has no overlay layers (drift only). `disabled` is not a look — the resolver returns `null`.

## File Structure

**New:**
- `src/heroLooks.ts` — types (`HeroMotion`, `HeroLookId`, `HeroEffectMode`, `HeroLayers`, `HeroLook`), `LOOKS`, `LOOK_IDS`, `EFFECT_MODE_OPTIONS`, `getLook`, `hasOverlayLayers`, `hashString`, `resolveHeroLook`, `coerceEffectMode`. Pure, no React.
- `src/__tests__/heroLooks.test.ts`

**Renamed/reshaped:**
- `src/heroTvEffect.ts` → `src/heroEffectMode.ts` (string store + migration)
- `src/__tests__/heroTvEffect.test.ts` → `src/__tests__/heroEffectMode.test.ts`

**Modified:**
- `src/store.ts`, `src/components/DetailHeroEffect.tsx`, `src/components/DetailHeroEffect.css`, `src/components/DetailHero.tsx`, `src/components/DetailHero.css`
- `src/__tests__/DetailHeroEffect.test.tsx`, `src/__tests__/DetailHero.test.tsx`

---

## Task 1: Create heroLooks.ts (pure look model + resolver) — TDD

**Files:**
- Create: `src/heroLooks.ts`
- Test: `src/__tests__/heroLooks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/heroLooks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  LOOKS,
  LOOK_IDS,
  EFFECT_MODE_OPTIONS,
  getLook,
  hasOverlayLayers,
  hashString,
  resolveHeroLook,
  coerceEffectMode,
} from "../heroLooks";

describe("heroLooks data", () => {
  it("defines exactly 8 looks", () => {
    expect(LOOKS).toHaveLength(8);
    expect(LOOK_IDS).toHaveLength(8);
  });

  it("LOOK_IDS mirrors LOOKS order", () => {
    expect(LOOK_IDS).toEqual(LOOKS.map((l) => l.id));
  });

  it("exposes 11 dropdown options in order (disabled, 8 looks, random, by-artist)", () => {
    const values = EFFECT_MODE_OPTIONS.map((o) => o.value);
    expect(values).toEqual([
      "disabled",
      ...LOOK_IDS,
      "random",
      "by-artist",
    ]);
    // every option has a non-empty label
    expect(EFFECT_MODE_OPTIONS.every((o) => o.label.length > 0)).toBe(true);
  });

  it("getLook returns the matching look", () => {
    expect(getLook("worn-tape").id).toBe("worn-tape");
    expect(getLook("minimal").motion).toBe("current");
  });

  it("hasOverlayLayers is false only for minimal", () => {
    expect(hasOverlayLayers(getLook("minimal"))).toBe(false);
    expect(hasOverlayLayers(getLook("worn-tape"))).toBe(true);
    expect(hasOverlayLayers(getLook("daydream"))).toBe(true);
  });
});

describe("hashString", () => {
  it("is deterministic", () => {
    expect(hashString("Radiohead")).toBe(hashString("Radiohead"));
  });
  it("returns a non-negative integer", () => {
    const h = hashString("Björk");
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
  });
  it("handles empty string without throwing", () => {
    expect(() => hashString("")).not.toThrow();
    expect(hashString("")).toBeGreaterThanOrEqual(0);
  });
});

describe("resolveHeroLook", () => {
  it("returns null for disabled", () => {
    expect(resolveHeroLook("disabled", "Anything", 0.5)).toBeNull();
  });

  it("returns the named look for a look id", () => {
    expect(resolveHeroLook("late-night", "X", 0.5)).toBe("late-night");
    expect(resolveHeroLook("minimal", "X", 0.5)).toBe("minimal");
  });

  it("random maps the roll across the looks and never returns disabled", () => {
    expect(resolveHeroLook("random", "X", 0)).toBe(LOOK_IDS[0]);
    expect(resolveHeroLook("random", "X", 0.999999)).toBe(LOOK_IDS[LOOK_IDS.length - 1]);
    for (let i = 0; i < 50; i++) {
      const id = resolveHeroLook("random", "X", i / 50);
      expect(LOOK_IDS).toContain(id);
    }
  });

  it("by-artist is deterministic for a name and always a valid look", () => {
    const a = resolveHeroLook("by-artist", "Radiohead", 0.1);
    const b = resolveHeroLook("by-artist", "Radiohead", 0.9);
    expect(a).toBe(b); // roll is ignored for by-artist
    expect(LOOK_IDS).toContain(a);
  });

  it("by-artist varies across different names (basic spread)", () => {
    const names = ["Radiohead", "Bjork", "Miles Davis", "Aphex Twin", "Nina Simone", "Boards of Canada"];
    const ids = new Set(names.map((n) => resolveHeroLook("by-artist", n, 0)));
    expect(ids.size).toBeGreaterThan(1);
  });

  it("by-artist with empty name resolves to a valid look (no throw)", () => {
    const id = resolveHeroLook("by-artist", "", 0);
    expect(LOOK_IDS).toContain(id);
  });
});

describe("coerceEffectMode (migration + validation)", () => {
  it("uses a valid stored mode string as-is", () => {
    expect(coerceEffectMode("silent-film", undefined)).toBe("silent-film");
    expect(coerceEffectMode("disabled", undefined)).toBe("disabled");
    expect(coerceEffectMode("random", undefined)).toBe("random");
  });
  it("migrates legacy boolean true -> worn-tape, false -> disabled", () => {
    expect(coerceEffectMode(undefined, true)).toBe("worn-tape");
    expect(coerceEffectMode(undefined, false)).toBe("disabled");
  });
  it("prefers a valid stored mode over the legacy boolean", () => {
    expect(coerceEffectMode("daydream", false)).toBe("daydream");
  });
  it("falls back to default worn-tape when nothing valid is present", () => {
    expect(coerceEffectMode(undefined, undefined)).toBe("worn-tape");
    expect(coerceEffectMode("nonsense", undefined)).toBe("worn-tape");
    expect(coerceEffectMode(42, undefined)).toBe("worn-tape");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/heroLooks.test.ts`
Expected: FAIL — cannot resolve `../heroLooks`.

- [ ] **Step 3: Write the module**

Create `src/heroLooks.ts`:

```ts
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
  const { bw, ...overlay } = look.layers;
  void bw;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/heroLooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/heroLooks.ts src/__tests__/heroLooks.test.ts
git commit -m "feat(hero): add look definitions and effect-mode resolver"
```

---

## Task 2: Convert the preference store to a string mode + migration — TDD

**Files:**
- Create: `src/heroEffectMode.ts`
- Delete: `src/heroTvEffect.ts`
- Create: `src/__tests__/heroEffectMode.test.ts`
- Delete: `src/__tests__/heroTvEffect.test.ts`
- Modify: `src/store.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/heroEffectMode.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const getMock = vi.fn();
const setMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../store", () => ({
  store: {
    get: (...args: unknown[]) => getMock(...args),
    set: (...args: unknown[]) => setMock(...args),
    init: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  getHeroEffectModeSnapshot,
  setHeroEffectMode,
  subscribeHeroEffectMode,
  loadHeroEffectModeForTest,
  __resetHeroEffectModeForTest,
} from "../heroEffectMode";

beforeEach(() => {
  getMock.mockReset();
  setMock.mockReset();
  setMock.mockResolvedValue(undefined);
  __resetHeroEffectModeForTest();
});

describe("heroEffectMode store", () => {
  it("defaults to worn-tape before any load", () => {
    expect(getHeroEffectModeSnapshot()).toBe("worn-tape");
  });

  it("setHeroEffectMode updates the snapshot and persists the string", () => {
    setHeroEffectMode("daydream");
    expect(getHeroEffectModeSnapshot()).toBe("daydream");
    expect(setMock).toHaveBeenCalledWith("heroEffectMode", "daydream");
  });

  it("notifies subscribers when the value changes", () => {
    const cb = vi.fn();
    const unsub = subscribeHeroEffectMode(cb);
    cb.mockClear();
    setHeroEffectMode("signal-lost");
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("does not notify or persist when set to the current value", () => {
    const cb = vi.fn();
    const unsub = subscribeHeroEffectMode(cb);
    cb.mockClear();
    setHeroEffectMode("worn-tape"); // already default
    expect(cb).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
    unsub();
  });

  it("loads a stored mode string and notifies", async () => {
    // first get: heroEffectMode, second get: legacy heroTvEffect (unused here)
    getMock.mockResolvedValueOnce("late-night").mockResolvedValueOnce(undefined);
    const cb = vi.fn();
    subscribeHeroEffectMode(cb);
    await loadHeroEffectModeForTest();
    expect(getHeroEffectModeSnapshot()).toBe("late-night");
    expect(cb).toHaveBeenCalled();
  });

  it("migrates a legacy boolean true to worn-tape and persists it", async () => {
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true);
    await loadHeroEffectModeForTest();
    expect(getHeroEffectModeSnapshot()).toBe("worn-tape");
    expect(setMock).toHaveBeenCalledWith("heroEffectMode", "worn-tape");
  });

  it("migrates a legacy boolean false to disabled and persists it", async () => {
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(false);
    await loadHeroEffectModeForTest();
    expect(getHeroEffectModeSnapshot()).toBe("disabled");
    expect(setMock).toHaveBeenCalledWith("heroEffectMode", "disabled");
  });

  it("keeps default when nothing is stored", async () => {
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    await loadHeroEffectModeForTest();
    expect(getHeroEffectModeSnapshot()).toBe("worn-tape");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/heroEffectMode.test.ts`
Expected: FAIL — cannot resolve `../heroEffectMode`.

- [ ] **Step 3: Create the module**

Create `src/heroEffectMode.ts`:

```ts
import { useSyncExternalStore } from "react";
import { store } from "./store";
import {
  coerceEffectMode,
  isValidMode,
  HERO_EFFECT_DEFAULT_MODE,
  type HeroEffectMode,
} from "./heroLooks";

const KEY = "heroEffectMode";
const LEGACY_KEY = "heroTvEffect";

let mode: HeroEffectMode = HERO_EFFECT_DEFAULT_MODE;
let loadStarted = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

async function load(): Promise<void> {
  try {
    const stored = await store.get<unknown>(KEY);
    let resolved: HeroEffectMode;
    if (isValidMode(stored)) {
      resolved = stored;
    } else {
      // Migrate the legacy boolean (true -> worn-tape, false -> disabled).
      const legacy = await store.get<unknown>(LEGACY_KEY);
      resolved = coerceEffectMode(stored, legacy);
      // Persist the migrated value so we never re-read the legacy key.
      if (resolved !== mode) {
        store
          .set(KEY, resolved)
          .catch((e) => console.error("Failed to persist migrated heroEffectMode:", e));
      } else {
        store
          .set(KEY, resolved)
          .catch((e) => console.error("Failed to persist migrated heroEffectMode:", e));
      }
    }
    if (resolved !== mode) {
      mode = resolved;
      emit();
    }
  } catch (e) {
    console.error("Failed to load heroEffectMode preference:", e);
  }
}

export function getHeroEffectModeSnapshot(): HeroEffectMode {
  return mode;
}

export function setHeroEffectMode(value: HeroEffectMode): void {
  if (value === mode) return;
  mode = value;
  emit();
  store
    .set(KEY, value)
    .catch((e) => console.error("Failed to persist heroEffectMode preference:", e));
}

export function subscribeHeroEffectMode(cb: () => void): () => void {
  listeners.add(cb);
  if (!loadStarted) {
    loadStarted = true;
    void load();
  }
  return () => {
    listeners.delete(cb);
  };
}

export function useHeroEffectMode(): [HeroEffectMode, (v: HeroEffectMode) => void] {
  const value = useSyncExternalStore(
    subscribeHeroEffectMode,
    getHeroEffectModeSnapshot,
    getHeroEffectModeSnapshot,
  );
  return [value, setHeroEffectMode];
}

// --- test-only helpers ---
export function loadHeroEffectModeForTest(): Promise<void> {
  return load();
}
export function __resetHeroEffectModeForTest(): void {
  mode = HERO_EFFECT_DEFAULT_MODE;
  loadStarted = false;
  listeners.clear();
}
```

> Note: the `if/else` around the migrated-persist both branches call `store.set` — collapse to a single `store.set(KEY, resolved).catch(...)` after computing `resolved` in the migration branch. Written expanded only to be explicit; simplify to one call:
>
> ```ts
>     } else {
>       const legacy = await store.get<unknown>(LEGACY_KEY);
>       resolved = coerceEffectMode(stored, legacy);
>       store
>         .set(KEY, resolved)
>         .catch((e) => console.error("Failed to persist migrated heroEffectMode:", e));
>     }
> ```

- [ ] **Step 4: Delete the old module and test**

```bash
git rm src/heroTvEffect.ts src/__tests__/heroTvEffect.test.ts
```

- [ ] **Step 5: Update the store default**

In `src/store.ts`, find:

```ts
  trackVideoHistory: true,
```

(unchanged) and find:

```ts
  minimizeToMiniPlayer: false,
  heroTvEffect: true,
};
```

Replace the `heroTvEffect: true,` line with `heroEffectMode: "worn-tape",`:

```ts
  minimizeToMiniPlayer: false,
  heroEffectMode: "worn-tape",
};
```

- [ ] **Step 6: Run tests + type-check**

Run: `npx vitest run src/__tests__/heroEffectMode.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: FAIL — `src/components/DetailHero.tsx` still imports `useHeroTvEffect` from the deleted module. That's expected; Task 5 fixes it. (Do not fix DetailHero here.)

> Because `tsc` will fail until Task 5, this task's commit is allowed with the known DetailHero breakage. The next two tasks (3, 4) touch DetailHeroEffect and CSS and do not depend on DetailHero compiling. If you prefer a always-green tree, do Tasks 2→5 before running a full `tsc`; the per-file vitest runs in Tasks 2/3/4 still pass because Vitest compiles per-module.

- [ ] **Step 7: Commit**

```bash
git add src/heroEffectMode.ts src/__tests__/heroEffectMode.test.ts src/store.ts
git commit -m "feat(hero): replace boolean pref with heroEffectMode string + migration"
```

---

## Task 3: Make DetailHeroEffect render a look — TDD

**Files:**
- Modify: `src/components/DetailHeroEffect.tsx`
- Test: `src/__tests__/DetailHeroEffect.test.tsx`

- [ ] **Step 1: Rewrite the test**

Replace the entire contents of `src/__tests__/DetailHeroEffect.test.tsx` with:

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { DetailHeroEffect, shouldPauseEffect } from "../components/DetailHeroEffect";
import { getLook } from "../heroLooks";

beforeEach(() => {
  // @ts-expect-error test stub
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error remove the IntersectionObserver test stub
  delete globalThis.IntersectionObserver;
});

describe("DetailHeroEffect", () => {
  it("renders nothing when look is null", () => {
    const { container } = render(<DetailHeroEffect look={null} />);
    expect(container.querySelector(".detail-hero-effect")).toBeNull();
  });

  it("renders nothing for a look with no overlay layers (minimal)", () => {
    const { container } = render(<DetailHeroEffect look={getLook("minimal")} />);
    expect(container.querySelector(".detail-hero-effect")).toBeNull();
  });

  it("renders the full VHS layer set for worn-tape", () => {
    const { container } = render(<DetailHeroEffect look={getLook("worn-tape")} />);
    const root = container.querySelector(".detail-hero-effect");
    expect(root).not.toBeNull();
    expect(root?.classList.contains("look-worn-tape")).toBe(true);
    expect(container.querySelector(".tv-bleed")).not.toBeNull();
    expect(container.querySelector(".tv-bleed-2")).not.toBeNull();
    expect(container.querySelector(".tv-scan")).not.toBeNull();
    expect(container.querySelector(".tv-track")).not.toBeNull();
    expect(container.querySelector(".tv-noise")).not.toBeNull();
    expect(container.querySelector(".tv-noise-2")).not.toBeNull();
    expect(container.querySelector(".tv-vignette")).not.toBeNull();
  });

  it("renders only the layers a look declares (late-night: scan+flicker+vignette)", () => {
    const { container } = render(<DetailHeroEffect look={getLook("late-night")} />);
    expect(container.querySelector(".tv-scan")).not.toBeNull();
    expect(container.querySelector(".tv-flicker")).not.toBeNull();
    expect(container.querySelector(".tv-vignette")).not.toBeNull();
    expect(container.querySelector(".tv-noise")).toBeNull();
    expect(container.querySelector(".tv-bleed")).toBeNull();
    expect(container.querySelector(".tv-track")).toBeNull();
  });

  it("renders the glitch slice for signal-lost", () => {
    const { container } = render(<DetailHeroEffect look={getLook("signal-lost")} />);
    expect(container.querySelector(".tv-slice")).not.toBeNull();
    expect(container.querySelector(".tv-bleed")).not.toBeNull();
  });

  it("sets the noise texture as a CSS custom property", () => {
    const { container } = render(<DetailHeroEffect look={getLook("worn-tape")} />);
    const root = container.querySelector(".detail-hero-effect") as HTMLElement;
    expect(root.style.getPropertyValue("--tv-noise")).toContain("url(");
  });
});

describe("shouldPauseEffect", () => {
  it("does not pause when on-screen and visible", () => {
    expect(shouldPauseEffect(true, true)).toBe(false);
  });
  it("pauses when off-screen", () => {
    expect(shouldPauseEffect(false, true)).toBe(true);
  });
  it("pauses when the page is hidden", () => {
    expect(shouldPauseEffect(true, false)).toBe(true);
  });
  it("pauses when both off-screen and hidden", () => {
    expect(shouldPauseEffect(false, false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/DetailHeroEffect.test.tsx`
Expected: FAIL — `DetailHeroEffect` still takes `active`, no `look-*` class, no `tv-flicker`/`tv-slice`.

- [ ] **Step 3: Rewrite the component**

Replace the entire contents of `src/components/DetailHeroEffect.tsx` with:

```tsx
import { useEffect, useRef } from "react";
import tvNoise from "../assets/tv-noise.png";
import { hasOverlayLayers, type HeroLook } from "../heroLooks";
import "./DetailHeroEffect.css";

interface Props {
  /** The resolved look to render, or null to render nothing. */
  look: HeroLook | null;
}

/**
 * Whether the effect's animations should be paused. We only spend animation
 * cycles when the hero is both on-screen AND the page is visible.
 */
export function shouldPauseEffect(onScreen: boolean, pageVisible: boolean): boolean {
  return !(onScreen && pageVisible);
}

/**
 * Old-TV / VHS background effect for the detail hero. Pure presentational +
 * GPU-composited CSS animation where possible. Pauses (via the `tv-paused`
 * class) when the hero is scrolled out of view or the window is hidden, so it
 * never burns cycles in the background. Static fallback for
 * prefers-reduced-motion lives in the CSS. The B&W background modifier and the
 * motion are applied by DetailHero on the hero root, not here.
 */
export function DetailHeroEffect({ look }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = look !== null && hasOverlayLayers(look);

  useEffect(() => {
    if (!visible) return;
    const el = rootRef.current;
    if (!el) return;

    let onScreen = true;
    let pageVisible = !document.hidden;

    const apply = () => {
      el.classList.toggle("tv-paused", shouldPauseEffect(onScreen, pageVisible));
    };

    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              onScreen = entries[0]?.isIntersecting ?? true;
              apply();
            },
            { threshold: 0 },
          )
        : null;
    io?.observe(el);

    const onVisibility = () => {
      pageVisible = !document.hidden;
      apply();
    };
    document.addEventListener("visibilitychange", onVisibility);
    apply();

    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [visible, look?.id]);

  if (!visible || !look) return null;

  const l = look.layers;
  return (
    <div
      ref={rootRef}
      className={`detail-hero-effect look-${look.id}`}
      aria-hidden="true"
      style={{ ["--tv-noise" as string]: `url(${tvNoise})` }}
    >
      {l.bleed && <div className="tv-bleed" />}
      {l.bleed2 && <div className="tv-bleed-2" />}
      {l.scan && <div className="tv-scan" />}
      {l.flicker && <div className="tv-flicker" />}
      {l.track && <div className="tv-track" />}
      {l.slice && <div className="tv-slice" />}
      {l.noise && <div className="tv-noise" />}
      {l.noise2 && <div className="tv-noise-2" />}
      {l.vignette && <div className="tv-vignette" />}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/DetailHeroEffect.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/DetailHeroEffect.tsx src/__tests__/DetailHeroEffect.test.tsx
git commit -m "feat(hero): render per-look layers in DetailHeroEffect"
```

---

## Task 4: Add new effect-layer styles + per-look CSS

**Files:**
- Modify: `src/components/DetailHeroEffect.css`

- [ ] **Step 1: Add the flicker and slice layer styles**

In `src/components/DetailHeroEffect.css`, after the `.tv-vignette` rule (the block ending at the `}` after the `radial-gradient`), and BEFORE the `/* --- paused: ... */` comment, insert:

```css
/* --- flicker (CRT brightness wobble) --- */
.tv-flicker {
  background: rgba(255, 255, 255, 0.03);
  animation: tv-flicker 4s steps(30) infinite;
}
@keyframes tv-flicker {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.7; }
  93% { opacity: 0.2; }
  97% { opacity: 0.9; }
}

/* --- glitch slice (bright band that jumps vertically + offsets) --- */
.tv-slice {
  height: 22px;
  inset: auto 0 auto 0;
  background: linear-gradient(
    0deg,
    rgba(255, 255, 255, 0),
    rgba(255, 255, 255, 0.5),
    rgba(255, 255, 255, 0)
  );
  mix-blend-mode: screen;
  animation: tv-slice 2.6s steps(1) infinite;
}
@keyframes tv-slice {
  0%   { top: 18%; transform: translateX(0); }
  10%  { top: 18%; transform: translateX(12px); }
  11%  { transform: translateX(0); }
  40%  { top: 62%; transform: translateX(0); }
  48%  { top: 62%; transform: translateX(-14px); }
  49%  { transform: translateX(0); }
  100% { top: 62%; }
}

/* --- per-look intensity / colour overrides --- */
/* silent-film: lighter screen-blended grain */
.look-silent-film .tv-noise { opacity: 0.5; mix-blend-mode: screen; }
/* signal-lost: stronger, cyan/magenta bleed + lighter grain */
.look-signal-lost .tv-noise { opacity: 0.4; }
.look-signal-lost .tv-bleed {
  background: linear-gradient(90deg, rgba(255, 0, 80, 0), rgba(255, 0, 80, 0.5));
}
.look-signal-lost .tv-bleed-2 {
  background: linear-gradient(270deg, rgba(0, 255, 200, 0), rgba(0, 255, 200, 0.5));
}
/* daydream: barely-there grain + soft vignette */
.look-daydream .tv-noise { opacity: 0.14; mix-blend-mode: screen; }
.look-daydream .tv-vignette {
  background: radial-gradient(ellipse at center, transparent 62%, rgba(0, 0, 0, 0.4) 100%);
}
/* broadcast: lighter VHS dial */
.look-broadcast .tv-noise { opacity: 0.45; }
.look-broadcast .tv-bleed {
  background: linear-gradient(90deg, rgba(255, 0, 80, 0), rgba(255, 0, 80, 0.2));
}
.look-broadcast .tv-bleed-2 {
  background: linear-gradient(270deg, rgba(0, 180, 255, 0), rgba(0, 180, 255, 0.2));
}
```

- [ ] **Step 2: Update the reduced-motion fallback to cover the new animated layers**

In the same file, find the existing reduced-motion block:

```css
@media (prefers-reduced-motion: reduce) {
  .tv-noise,
  .tv-noise-2,
  .tv-bleed,
  .tv-bleed-2,
  .tv-track {
    display: none;
  }
  .tv-scan,
  .tv-vignette {
    animation: none;
  }
}
```

Replace it with (adds `tv-slice` and `tv-flicker` to the hidden set):

```css
@media (prefers-reduced-motion: reduce) {
  .tv-noise,
  .tv-noise-2,
  .tv-bleed,
  .tv-bleed-2,
  .tv-track,
  .tv-slice,
  .tv-flicker {
    display: none;
  }
  .tv-scan,
  .tv-vignette {
    animation: none;
  }
}
```

- [ ] **Step 3: Verify the effect tests still pass + type-check the file's consumers later**

Run: `npx vitest run src/__tests__/DetailHeroEffect.test.tsx`
Expected: PASS (CSS isn't asserted, but this confirms nothing broke).

- [ ] **Step 4: Commit**

```bash
git add src/components/DetailHeroEffect.css
git commit -m "feat(hero): add flicker/slice layers and per-look effect styles"
```

---

## Task 5: Wire the dropdown + look resolution into DetailHero — TDD

**Files:**
- Modify: `src/components/DetailHero.tsx`
- Test: `src/__tests__/DetailHero.test.tsx`

- [ ] **Step 1: Rewrite the test**

Replace the entire contents of `src/__tests__/DetailHero.test.tsx` with:

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { DetailHero } from "../components/DetailHero";
import { __resetHeroEffectModeForTest } from "../heroEffectMode";
import { EFFECT_MODE_OPTIONS } from "../heroLooks";

vi.mock("../store", () => ({
  store: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
  },
}));

beforeEach(() => {
  __resetHeroEffectModeForTest();
  // @ts-expect-error test stub
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error remove the IntersectionObserver test stub
  delete globalThis.IntersectionObserver;
});

function renderHero() {
  return render(
    <DetailHero
      bgImages={["/a.jpg"]}
      art={<div>art</div>}
      artShape="square"
      title="Test Title"
      entityLabel="album"
      meta={[]}
      overflowItems={[]}
    />,
  );
}

function getSelect(container: HTMLElement): HTMLSelectElement {
  return container.querySelector(".detail-hero-fx-select") as HTMLSelectElement;
}

describe("DetailHero effect picker", () => {
  it("renders a select with all 11 mode options", () => {
    const { container } = renderHero();
    const select = getSelect(container);
    expect(select).not.toBeNull();
    expect(select.querySelectorAll("option")).toHaveLength(EFFECT_MODE_OPTIONS.length);
    expect(EFFECT_MODE_OPTIONS).toHaveLength(11);
  });

  it("defaults to worn-tape and renders the effect overlay", () => {
    const { container } = renderHero();
    expect(getSelect(container).value).toBe("worn-tape");
    expect(container.querySelector(".detail-hero-effect")).not.toBeNull();
    expect(container.querySelector(".detail-hero.hero-motion-wander")).not.toBeNull();
  });

  it("Disabled removes the overlay and the motion class (static hero)", () => {
    const { container } = renderHero();
    fireEvent.change(getSelect(container), { target: { value: "disabled" } });
    expect(container.querySelector(".detail-hero-effect")).toBeNull();
    expect(container.querySelector(".detail-hero[class*='hero-motion-']")).toBeNull();
  });

  it("Minimal keeps motion (current) but renders no overlay", () => {
    const { container } = renderHero();
    fireEvent.change(getSelect(container), { target: { value: "minimal" } });
    expect(container.querySelector(".detail-hero.hero-motion-current")).not.toBeNull();
    expect(container.querySelector(".detail-hero-effect")).toBeNull();
  });

  it("a named look renders its overlay and motion class", () => {
    const { container } = renderHero();
    fireEvent.change(getSelect(container), { target: { value: "late-night" } });
    expect(container.querySelector(".detail-hero-effect.look-late-night")).not.toBeNull();
    expect(container.querySelector(".detail-hero.hero-motion-breathe")).not.toBeNull();
  });

  it("silent-film adds the B&W root modifier", () => {
    const { container } = renderHero();
    fireEvent.change(getSelect(container), { target: { value: "silent-film" } });
    expect(container.querySelector(".detail-hero.hero-bw")).not.toBeNull();
  });

  it("by-artist resolves to some overlay (non-null) deterministically", () => {
    const { container } = renderHero();
    fireEvent.change(getSelect(container), { target: { value: "by-artist" } });
    // "Test Title" hashes to a valid look; all but minimal have an overlay, but
    // at minimum a motion class is always applied for a resolved look.
    expect(container.querySelector(".detail-hero[class*='hero-motion-']")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/DetailHero.test.tsx`
Expected: FAIL — DetailHero still renders the checkbox and imports the deleted module.

- [ ] **Step 3: Edit DetailHero.tsx — imports**

In `src/components/DetailHero.tsx`, replace these two import lines:

```tsx
import { DetailHeroEffect } from "./DetailHeroEffect";
import { useHeroTvEffect } from "../heroTvEffect";
```

with:

```tsx
import { useRef } from "react";
import { DetailHeroEffect } from "./DetailHeroEffect";
import { useHeroEffectMode } from "../heroEffectMode";
import {
  resolveHeroLook,
  getLook,
  EFFECT_MODE_OPTIONS,
  type HeroEffectMode,
} from "../heroLooks";
```

- [ ] **Step 4: Edit DetailHero.tsx — resolve the look and build the root class**

Replace this line:

```tsx
  const showLike = liked !== undefined && (onToggleLike || likeDisabled);
  const [tvEffect, setTvEffect] = useHeroTvEffect();
```

with:

```tsx
  const showLike = liked !== undefined && (onToggleLike || likeDisabled);
  const [effectMode, setEffectMode] = useHeroEffectMode();
  // One random roll per mount, so "Random" stays stable while on this page and
  // re-rolls when the hero is navigated away and back. Ignored for other modes.
  const rollRef = useRef(Math.random());
  const lookId = resolveHeroLook(effectMode, title, rollRef.current);
  const look = lookId ? getLook(lookId) : null;
  const heroClass = [
    "detail-hero",
    look ? `hero-motion-${look.motion}` : "",
    look?.layers.bw ? "hero-bw" : "",
  ]
    .filter(Boolean)
    .join(" ");
```

- [ ] **Step 5: Edit DetailHero.tsx — root element + control**

Replace this block:

```tsx
    <div className="detail-hero">
      <DetailHeroBackground images={bgImages} className={bgClassName ?? "detail-hero-bg"} />
      <DetailHeroEffect active={tvEffect} />
      <label
        className="detail-hero-tv-toggle"
        title="Old-TV background effect"
      >
        <input
          type="checkbox"
          checked={tvEffect}
          onChange={(e) => setTvEffect(e.target.checked)}
          aria-label="Toggle old-TV background effect"
        />
        <span className="detail-hero-tv-toggle-glyph" aria-hidden>📺</span>
      </label>
      <div className="detail-hero-row">
```

with:

```tsx
    <div className={heroClass}>
      <DetailHeroBackground images={bgImages} className={bgClassName ?? "detail-hero-bg"} />
      <DetailHeroEffect look={look} />
      <select
        className="detail-hero-fx-select"
        value={effectMode}
        onChange={(e) => setEffectMode(e.target.value as HeroEffectMode)}
        aria-label="Hero background effect"
        title="Hero background effect"
      >
        {EFFECT_MODE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="detail-hero-row">
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/__tests__/DetailHero.test.tsx`
Expected: PASS.

- [ ] **Step 7: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors (the Task 2 breakage is now resolved).

- [ ] **Step 8: Commit**

```bash
git add src/components/DetailHero.tsx src/__tests__/DetailHero.test.tsx
git commit -m "feat(hero): replace toggle with effect-mode dropdown + look resolution"
```

---

## Task 6: Motion classes, B&W modifier, and select styling in DetailHero.css

**Files:**
- Modify: `src/components/DetailHero.css`

- [ ] **Step 1: Revert the background to static + move motion onto root-scoped classes**

In `src/components/DetailHero.css`, replace this block:

```css
.detail-hero-bg {
  position: absolute;
  inset: -8%; /* oversized so pan/zoom never reveals the hero edges */
  z-index: 0;
  transform-origin: center;
  will-change: transform;
  animation: detail-hero-kenburns 28s ease-in-out infinite alternate;
}

@keyframes detail-hero-kenburns {
  0%   { transform: scale(1.08) translate(0, 0); }
  25%  { transform: scale(1.14) translate(-2.5%, -1.5%); }
  50%  { transform: scale(1.12) translate(2%, 1.5%); }
  75%  { transform: scale(1.16) translate(1.5%, -2%); }
  100% { transform: scale(1.10) translate(-2%, 2%); }
}

@media (prefers-reduced-motion: reduce) {
  .detail-hero-bg { animation: none; inset: 0; }
}
```

with:

```css
/* Base background is static (the original pre-effect look = "Disabled"). */
.detail-hero-bg { position: absolute; inset: 0; z-index: 0; }

/* Any motion look oversizes the background so pan/zoom never reveals edges. */
.detail-hero[class*="hero-motion-"] .detail-hero-bg {
  inset: -8%;
  transform-origin: center;
  will-change: transform;
}

.detail-hero.hero-motion-current .detail-hero-bg {
  animation: hero-motion-current 28s ease-in-out infinite alternate;
}
.detail-hero.hero-motion-focal .detail-hero-bg {
  animation: hero-motion-focal 32s ease-in-out infinite;
}
.detail-hero.hero-motion-breathe .detail-hero-bg {
  animation: hero-motion-breathe 12s ease-in-out infinite;
}
.detail-hero.hero-motion-push .detail-hero-bg {
  animation: hero-motion-push 24s ease-in-out infinite;
}
.detail-hero.hero-motion-sway .detail-hero-bg {
  animation: hero-motion-sway 20s ease-in-out infinite alternate;
}
.detail-hero.hero-motion-wander .detail-hero-bg {
  animation: hero-motion-wander 40s ease-in-out infinite;
}

@keyframes hero-motion-current {
  0%   { transform: scale(1.08) translate(0, 0); }
  25%  { transform: scale(1.14) translate(-2.5%, -1.5%); }
  50%  { transform: scale(1.12) translate(2%, 1.5%); }
  75%  { transform: scale(1.16) translate(1.5%, -2%); }
  100% { transform: scale(1.10) translate(-2%, 2%); }
}
@keyframes hero-motion-focal {
  0%   { transform: scale(1.10); transform-origin: 30% 28%; }
  24%  { transform: scale(1.22); transform-origin: 30% 28%; }
  26%  { transform: scale(1.10); transform-origin: 72% 35%; }
  50%  { transform: scale(1.24); transform-origin: 72% 35%; }
  52%  { transform: scale(1.10); transform-origin: 50% 70%; }
  76%  { transform: scale(1.22); transform-origin: 50% 70%; }
  78%  { transform: scale(1.10); transform-origin: 40% 20%; }
  100% { transform: scale(1.18); transform-origin: 40% 20%; }
}
@keyframes hero-motion-breathe {
  0%   { transform: scale(1.06); }
  50%  { transform: scale(1.20); }
  100% { transform: scale(1.06); }
}
@keyframes hero-motion-push {
  0%   { transform: scale(1.05) translate(2%, 2%); }
  92%  { transform: scale(1.24) translate(-2%, -3%); }
  100% { transform: scale(1.24) translate(-2%, -3%); }
}
@keyframes hero-motion-sway {
  0%   { transform: scale(1.16) translateX(-5%); }
  100% { transform: scale(1.16) translateX(5%); }
}
@keyframes hero-motion-wander {
  0%   { transform: scale(1.12); transform-origin: 35% 30%; }
  17%  { transform: scale(1.20); transform-origin: 65% 45%; }
  33%  { transform: scale(1.10); transform-origin: 50% 65%; }
  50%  { transform: scale(1.22); transform-origin: 25% 50%; }
  67%  { transform: scale(1.14); transform-origin: 70% 25%; }
  83%  { transform: scale(1.20); transform-origin: 45% 55%; }
  100% { transform: scale(1.12); transform-origin: 35% 30%; }
}

/* B&W look modifier (applied on the hero root by DetailHero). */
.detail-hero.hero-bw .detail-hero-bg {
  filter: grayscale(1) contrast(1.25) brightness(0.92);
}
.detail-hero.hero-bw .detail-hero-art img {
  filter: grayscale(1) contrast(1.1);
}

@media (prefers-reduced-motion: reduce) {
  .detail-hero-bg { animation: none !important; inset: 0 !important; }
}
```

- [ ] **Step 2: Replace the toggle styles with select styles**

In `src/components/DetailHero.css`, find the toggle block (added in the prior feature):

```css
/* --- Old-TV effect corner toggle --- */
.detail-hero-tv-toggle {
  position: absolute;
  top: 12px;
  right: 14px;
  z-index: 4;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border-radius: 999px;
  background: rgba(var(--bg-primary-rgb), 0.45);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
}

/* Hover-reveal: show while pointer is over the hero, or when focused for a11y. */
.detail-hero:hover .detail-hero-tv-toggle,
.detail-hero-tv-toggle:focus-within {
  opacity: 1;
}

/* Keep the keyboard focus ring visible inside the semi-transparent pill. */
.detail-hero-tv-toggle:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.detail-hero-tv-toggle input[type="checkbox"] {
  accent-color: var(--accent);
  cursor: pointer;
  margin: 0;
}

.detail-hero-tv-toggle-glyph {
  font-size: var(--fs-xs);
  line-height: 1;
}
```

Replace that entire block with:

```css
/* --- Hero effect picker (top-right, hover-revealed) --- */
.detail-hero-fx-select {
  position: absolute;
  top: 12px;
  right: 14px;
  z-index: 4;
  max-width: 160px;
  padding: 5px 9px;
  border-radius: var(--ds-radius);
  background: rgba(var(--bg-primary-rgb), 0.55);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
}

/* Hover-reveal: show while pointer is over the hero, or when focused for a11y. */
.detail-hero:hover .detail-hero-fx-select,
.detail-hero-fx-select:focus {
  opacity: 1;
}

.detail-hero-fx-select:focus {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.detail-hero-fx-select option {
  color: var(--text-primary);
  background: var(--bg-surface);
}
```

- [ ] **Step 3: Verify tests + type-check**

Run: `npx vitest run src/__tests__/DetailHero.test.tsx src/__tests__/DetailHeroBackground.test.tsx`
Expected: PASS (class names `.detail-hero-bg` unchanged; `DetailHeroBackground.test.tsx` unaffected).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/DetailHero.css
git commit -m "feat(hero): motion classes, B&W modifier, and effect-picker select styles"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full TypeScript test suite**

Run: `npm test`
Expected: PASS, including `heroLooks`, `heroEffectMode`, `DetailHeroEffect`, `DetailHero`. The old `heroTvEffect.test.ts` must no longer exist.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Grep for stale references**

Run: `grep -rn "heroTvEffect\|useHeroTvEffect\|DetailHeroEffect active" src` 
Expected: no matches (all renamed). If any appear, fix them.

- [ ] **Step 4: Manual verification in the Tauri webview**

Run: `npm run tauri dev`. On an Artist, Album, Track, and Tag detail page, confirm:
- [ ] The hover-revealed dropdown (top-right) lists all 11 options.
- [ ] **Disabled** returns the hero to the original static look — no drift, no overlay (background sits at `inset:0`, not drifting).
- [ ] Each of the 8 looks renders its intended motion + effect (spot-check Worn Tape, Late Night TV, Silent Film B&W, Signal Lost glitch, Daydream, Minimal = drift only).
- [ ] **Random** lands on a look; navigating away and back can change it.
- [ ] **By artist** gives the same look for the same page name every time, and different artists differ.
- [ ] Selection persists across an app restart.
- [ ] A previously-installed boolean value migrates: simulate by setting `heroTvEffect` in the store (or trust the unit test) — `true` → Worn Tape, `false` → Disabled.
- [ ] Title/buttons stay crisp and clickable; dropdown is usable.
- [ ] Holds across one light and one dark skin.
- [ ] OS "Reduce motion" → drift + animated layers stop (static scanlines/vignette only where applicable).

- [ ] **Step 5: Final commit (only if Step 4 surfaced tweaks)**

```bash
git add -A
git commit -m "fix(hero): tune effect presets after manual verification"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- 11 options (Disabled + 8 looks + Random + By-artist) → `EFFECT_MODE_OPTIONS` (Task 1), rendered in the select (Task 5). ✓
- Disabled = pre-feature static (no drift, no overlay) → resolver returns null (Task 1); no motion class + null overlay (Task 5); base `.detail-hero-bg` reverts to `inset:0` static (Task 6). ✓
- 8 bundled motion×effect looks → `LOOKS` table (Task 1), layer rendering (Task 3), per-look CSS + motions (Tasks 4, 6). ✓
- Random re-rolls per page visit → per-mount `rollRef` (Task 5); resolver maps roll, never disabled (Task 1). ✓
- By-artist hashes the page's primary `title`, never disabled → resolver (Task 1), passes `title` (Task 5). ✓
- Boolean→string migration (`true→worn-tape`, `false→disabled`) → `coerceEffectMode` (Task 1) + store load order (Task 2). ✓
- Default `worn-tape` → store default (Task 2) + module default (Task 1). ✓
- Reuse GPU layers, pause, reduced-motion → preserved in Tasks 3/4; motion reduced-motion in Task 6. ✓
- Data-driven looks + pure resolver, exhaustively tested → Task 1 tests. ✓
- New layers (flicker, slice), B&W modifier → Tasks 3/4 (overlay) + Task 6 (bw on root). ✓
- Glitch slice decoupling (no art sampling) → documented + implemented as a bright band (Tasks 3/4). ✓
- Skin compliance of the select → uses `--bg-primary-rgb`, `--border`, `--text-*`, `--accent`, `--ds-radius`, `--fs-xs` (Task 6). ✓
- Testing per testing.md → pure-logic heavy (Task 1), store (Task 2), light render (Tasks 3/5). ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases". Every code step has complete code. The one prose note (collapsing the migration `if/else` into a single `store.set`) is explicit and includes the final code. ✓

**Type/name consistency:** Exports used consistently — `resolveHeroLook`, `getLook`, `hasOverlayLayers`, `coerceEffectMode`, `EFFECT_MODE_OPTIONS`, `LOOK_IDS`, `hashString`, `HERO_EFFECT_DEFAULT_MODE` (Task 1) consumed in Tasks 2/3/5. Store exports `useHeroEffectMode`, `getHeroEffectModeSnapshot`, `setHeroEffectMode`, `subscribeHeroEffectMode`, `loadHeroEffectModeForTest`, `__resetHeroEffectModeForTest` (Task 2) used in Tasks 2/5 tests. `DetailHeroEffect` prop `look: HeroLook | null` matches between component (Task 3) and call site (Task 5). CSS classes (`detail-hero-effect`, `look-<id>`, `tv-flicker`, `tv-slice`, `hero-motion-<motion>`, `hero-bw`, `detail-hero-fx-select`) match across component, CSS, and tests. ✓
```
