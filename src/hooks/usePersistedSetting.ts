import { useEffect, useRef, useState } from "react";
import { store } from "../store";
import { useLatestRef } from "./useLatestRef";

// The one implementation of "a setting that persists to the app store".
// App.tsx used to hand-write each persisted setting at three or four sites —
// a useState, a handleXxxChange doing setX(v) + store.set(...), sometimes a
// separate restore-guarded persist effect, plus the restore read — and the
// copies drifted: several handlers lost their .catch(console.error), and a
// setter called from anywhere but its handler silently didn't persist.
//
// Restore is owned here too. Each setting registers a hydrator under its store
// key; the startup restore reads the whole store once and calls
// `hydratePersistedSettings(snapshot)`, which hands every registered setting
// its saved value while restoredRef is still false — so nothing is written back
// during restore, and every post-restore change persists no matter which code
// path called the setter. A setting therefore needs no line in the restore
// effect unless restoring it has a side effect (an engine call, a DOM attr) or
// a migration from a retired key.

type Hydrator = (raw: unknown) => void;
const hydrators = new Map<string, Hydrator>();

/** Hand every registered persisted setting its saved value. Keys absent from
 *  the snapshot keep their defaults. Call once, during restore (restoredRef
 *  still false), with the store's merged entries. */
export function hydratePersistedSettings(snapshot: ReadonlyMap<string, unknown>): void {
  for (const [key, hydrate] of hydrators) {
    if (snapshot.has(key)) hydrate(snapshot.get(key));
  }
}

/** Default restore: accept a saved value only when it has the default's shape
 *  (same primitive type, an array for an array, a plain object for an object).
 *  Anything else — a value from a much older build, a hand-edited file — is
 *  ignored and the default stands. A `null` default has no shape to compare
 *  against, so such a setting must pass its own `restore`. */
export function sameShape<T>(raw: unknown, fallback: T): T | undefined {
  if (raw === undefined || raw === null || fallback === null || fallback === undefined) return undefined;
  if (Array.isArray(fallback)) return Array.isArray(raw) ? (raw as T) : undefined;
  if (typeof fallback === "object") {
    return typeof raw === "object" && !Array.isArray(raw) ? (raw as T) : undefined;
  }
  if (typeof raw !== typeof fallback) return undefined;
  if (typeof raw === "number" && !Number.isFinite(raw)) return undefined;
  return raw as T;
}

export interface PersistedSettingOptions<T> {
  /** Turn the saved raw value into the setting's value, or `undefined` to keep
   *  the default. Defaults to `sameShape` against the initial value. */
  restore?: (raw: unknown) => T | undefined;
}

/** Owns the state, the persistence AND the restore for a store-backed setting.
 *  Drop-in for useState: `const [x, setX] = usePersistedSetting("x", def, restoredRef)`.
 *  Side effects beyond persistence (DOM attrs, engine calls) stay in a slim
 *  handler that calls the setter. */
export function usePersistedSetting<T>(
  key: string,
  initial: T | (() => T),
  restoredRef: React.RefObject<boolean>,
  options?: PersistedSettingOptions<T>,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  // The first render's value is the default (useRef's argument is read once).
  const defaultRef = useRef(value);
  const restoreRef = useLatestRef(options?.restore);
  useEffect(() => {
    const hydrate: Hydrator = (raw) => {
      const restore = restoreRef.current;
      const next = restore ? restore(raw) : sameShape(raw, defaultRef.current);
      if (next !== undefined) setValue(() => next);
    };
    hydrators.set(key, hydrate);
    return () => {
      if (hydrators.get(key) === hydrate) hydrators.delete(key);
    };
  }, [key, restoreRef]);
  useEffect(() => {
    if (!restoredRef.current) return;
    store.set(key, value).catch((e) => console.error(`Failed to persist ${key}:`, e));
    // `key` is fixed per call site; only the value drives writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return [value, setValue];
}

/** Persist-only mirror for state OWNED BY ANOTHER HOOK (the EQ/ReplayGain
 *  values live in usePlayback; App only mirrors them to the store). Replaces
 *  the five-line guarded useEffect each of those keys used to carry. */
export function usePersistMirror<T>(
  key: string,
  value: T,
  restoredRef: React.RefObject<boolean>,
): void {
  useEffect(() => {
    if (!restoredRef.current) return;
    store.set(key, value).catch((e) => console.error(`Failed to persist ${key}:`, e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
}
