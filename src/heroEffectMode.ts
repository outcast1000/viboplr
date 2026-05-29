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
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

// Coalesce concurrent loads so the subscribe-triggered load and any explicit
// load share a single store read (and a single legacy migration).
function load(): Promise<void> {
  if (!loadPromise) loadPromise = doLoad();
  return loadPromise;
}

async function doLoad(): Promise<void> {
  try {
    const stored = await store.get<unknown>(KEY);
    let resolved: HeroEffectMode;
    if (isValidMode(stored)) {
      resolved = stored;
    } else {
      // Migrate the legacy boolean (true -> by-artist, false -> disabled).
      const legacy = await store.get<unknown>(LEGACY_KEY);
      resolved = coerceEffectMode(stored, legacy);
      // Only persist when we actually migrated a legacy value, so a fresh
      // install doesn't write the default to disk before the user picks anything.
      if (typeof legacy === "boolean") {
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
  loadPromise = null;
  listeners.clear();
}
