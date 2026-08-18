import { useInsertionEffect, useRef, type RefObject } from "react";

/**
 * The two primitives for the "latest ref" pattern — a ref that always holds the
 * newest value/closure so async consumers (event handlers, timers, mpv/Tauri
 * event listeners, plugin callbacks) can read it without being re-subscribed on
 * every render.
 *
 * ## Why `useInsertionEffect` and not a bare render-body assignment
 *
 * The pattern used to be written inline as `xRef.current = value;` in a
 * component/hook body. That is a **write during render**, which React does not
 * allow: under StrictMode double-render and under concurrent rendering a render
 * can be started and thrown away, so the ref gets mutated for a tree that never
 * commits. `react-hooks/refs` (the React Compiler rule set, wired up in
 * `eslint.config.js`) reports it as an error.
 *
 * `useInsertionEffect` is the correct home for the write, and specifically NOT
 * `useLayoutEffect`/`useEffect`, because of commit ordering:
 *
 *   mutation phase   -> ALL insertion effects, whole tree
 *   layout phase     -> useLayoutEffect, child-before-parent
 *   passive phase    -> useEffect, child-before-parent
 *
 * Layout and passive effects run bottom-up, so a parent writing the ref in one
 * of those would publish the new value *after* a child's effect had already read
 * the stale one. Insertion effects all complete before any layout or passive
 * effect anywhere in the tree, so the ref is guaranteed fresh by the time
 * anything can observe it. This is the same mechanism React's own
 * `useEffectEvent` polyfill uses.
 *
 * The write is intentionally dependency-free: it re-runs on every commit, which
 * costs one assignment and removes any chance of a stale closure surviving
 * because a dep list was wrong.
 *
 * ## What this does NOT fix
 *
 * These refs are still refs. Anything that reads `.current` **during render**
 * stays wrong (it will read the previous commit's value) and is still reported
 * by `react-hooks/refs`. Use state for values that render output depends on.
 */

/**
 * Mirrors `value` into a fresh ref. Use when the ref is created and fed at the
 * same place:
 *
 *   const crossfadeSecsRef = useLatestRef(crossfadeSecs);
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useInsertionEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Writes `value` into a ref that already exists. Use when the ref must be
 * handed to a consumer *before* the value it will carry exists — the
 * forward-declaration case that makes up most of App.tsx, where a ref is passed
 * into `usePlayback` near the top of the component and only filled in hundreds
 * of lines later once the handler it points at has been defined:
 *
 *   const nativeEndedRef = useRef<() => void>(() => {});
 *   ...
 *   useAssignRef(nativeEndedRef, () => handleNext("auto"));
 *
 * Like every hook this must be called unconditionally and in a stable order.
 */
export function useAssignRef<T>(ref: RefObject<T>, value: T): void {
  useInsertionEffect(() => {
    ref.current = value;
  });
}
