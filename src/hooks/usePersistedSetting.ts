import { useEffect, useState } from "react";
import { store } from "../store";

// The one implementation of "a setting that persists to the app store".
// App.tsx used to hand-write each persisted setting at three or four sites —
// a useState, a handleXxxChange doing setX(v) + store.set(...), sometimes a
// separate restore-guarded persist effect, plus the restore read — and the
// copies drifted: several handlers lost their .catch(console.error), and a
// setter called from anywhere but its handler silently didn't persist.
//
// Restore still works exactly as before: the startup effect reads the saved
// value (readPersistedSettings) and calls the setter while restoredRef is
// false, so nothing is written back during restore; every post-restore change
// persists no matter which code path called the setter.

/** Owns the state AND the persistence for a store-backed setting.
 *  Drop-in for useState: `const [x, setX] = usePersistedSetting("x", def, restoredRef)`.
 *  Side effects beyond persistence (DOM attrs, engine calls) stay in a slim
 *  handler that calls the setter. */
export function usePersistedSetting<T>(
  key: string,
  initial: T | (() => T),
  restoredRef: React.RefObject<boolean>,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
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
