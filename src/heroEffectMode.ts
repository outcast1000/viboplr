import { useSyncExternalStore } from "react";
import { store } from "./store";
import {
  coerceEffectMode,
  HERO_EFFECT_DEFAULT_MODE,
  type HeroEffectMode,
} from "./heroLooks";

const KEY = "heroEffectMode";

let mode: HeroEffectMode = HERO_EFFECT_DEFAULT_MODE;
let loadStarted = false;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

// Coalesce concurrent loads so the subscribe-triggered load and any explicit
// load share a single store read.
function load(): Promise<void> {
  if (!loadPromise) loadPromise = doLoad();
  return loadPromise;
}

async function doLoad(): Promise<void> {
  try {
    const resolved = coerceEffectMode(await store.get<unknown>(KEY));
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
