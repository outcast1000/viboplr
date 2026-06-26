import {
  listen,
  type EventCallback,
  type EventName,
  type Options,
  type UnlistenFn,
} from "@tauri-apps/api/event";

/**
 * Call an unlisten function, swallowing the tauri 2.11 stale-id rejection.
 *
 * tauri 2.11's injected `unregisterListener` dereferences
 * `listeners[eventId].handlerId` without a null check (see
 * `tauri/src/event/mod.rs` `unlisten_js_script`), and it never deletes an
 * emptied per-event bucket. So unlistening an id that's already been removed —
 * a normal race when a React effect cleans up around the async `listen()`
 * resolution — throws inside an async fn and surfaces as an unhandled promise
 * rejection ("undefined is not an object (evaluating 'listeners[eventId].handlerId')").
 * The listener is already gone server-side, so the call is a harmless no-op; we
 * just silence the rejection.
 */
export function safeUnlisten(fn: UnlistenFn | undefined | null): void {
  if (!fn) return;
  try {
    // unlisten is async under the hood; the stale-id bug rejects rather than
    // throwing synchronously, so guard the returned promise too.
    void Promise.resolve(fn()).catch(() => {
      /* stale-id no-op — see safeUnlisten docs */
    });
  } catch {
    /* defensive: same stale-id guard for any synchronous throw */
  }
}

/**
 * `listen()` wrapped for safe use as a React effect cleanup.
 *
 * Returns a synchronous stop function that unlistens exactly once and never
 * throws (see {@link safeUnlisten}). Also covers the case where the effect
 * cleans up before the async `listen()` has resolved — the listener is torn
 * down as soon as it registers.
 *
 * Use the returned stop directly as a cleanup, or compose several with
 * {@link combineUnlisten}:
 * ```ts
 * useEffect(() => subscribe("evt", handler), [deps]);
 * useEffect(() => combineUnlisten(
 *   subscribe("a", onA),
 *   subscribe("b", onB),
 * ), [deps]);
 * ```
 */
export function subscribe<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): () => void {
  let unlisten: UnlistenFn | undefined;
  let stopped = false;
  listen<T>(event, handler, options)
    .then((fn) => {
      if (stopped) safeUnlisten(fn); // cleanup ran before listen() resolved
      else unlisten = fn;
    })
    .catch((e) => console.error(`Failed to listen for "${event}":`, e));
  return () => {
    stopped = true;
    const fn = unlisten;
    unlisten = undefined; // guard against a second invocation
    safeUnlisten(fn);
  };
}

/** Compose several stop functions into one effect-cleanup callback. */
export function combineUnlisten(...stops: Array<() => void>): () => void {
  return () => {
    for (const stop of stops) stop();
  };
}
