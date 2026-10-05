// Cancelling a plugin's `api.network.fetch`. The plugin passes a standard
// `AbortSignal`; the request runs in Rust, so aborting means telling the
// backend to drop it (`plugin_fetch_cancel`), keyed by an id minted here.
//
// A worker plugin can't send a signal across the RPC boundary (it isn't
// structured-cloneable), so the worker runtime swaps it for `__onAbort` — a
// function, which the RPC does carry — that registers the host's cancel with
// the signal on the worker side. The host accepts either.

/** What Rust's `plugin_fetch` rejects with when cancelled (`FETCH_ABORTED`). */
export const FETCH_ABORTED = "__fetch_aborted__";

/** The error a cancelled fetch rejects with — `name` is what plugins check,
 *  matching what `fetch()` itself throws. */
export function abortError(): Error {
  const e = new Error("The request was cancelled.");
  e.name = "AbortError";
  return e;
}

export function isFetchAborted(e: unknown): boolean {
  return e === FETCH_ABORTED || (e instanceof Error && e.message === FETCH_ABORTED);
}

export interface FetchAbortInit {
  signal?: AbortSignal;
  /** Worker runtime only: registers the host's cancel with the worker's signal. */
  __onAbort?: (cancel: () => void) => unknown;
}

let seq = 0;

/**
 * Arm cancellation for one fetch. Returns `null` when the caller passed no
 * cancel source (the request then runs exactly as before, uncancellable), or
 * the request id to send plus `settle`, to call once the request is over so a
 * late abort doesn't send a cancel for nothing. Throws `abortError()` when the
 * signal is already aborted — nothing is sent at all.
 */
export function armFetchAbort(
  pluginId: string,
  init: FetchAbortInit | undefined,
  cancel: (requestId: string) => void,
): { requestId: string; settle: () => void } | null {
  if (!init?.signal && typeof init?.__onAbort !== "function") return null;
  if (init.signal?.aborted) throw abortError();
  const requestId = `${pluginId}:${Date.now().toString(36)}:${++seq}`;
  let done = false;
  const onAbort = () => {
    if (!done) cancel(requestId);
  };
  if (init.signal) {
    init.signal.addEventListener("abort", onAbort, { once: true });
  } else {
    Promise.resolve(init.__onAbort!(onAbort)).catch((e) => console.error("Failed to arm plugin fetch cancel:", e));
  }
  return {
    requestId,
    settle: () => {
      done = true;
      init.signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Worker side: replace `signal` with `__onAbort` so the init can cross the RPC.
 * Throws `abortError()` for a signal that is already aborted.
 */
export function workerFetchInit(init: unknown): unknown {
  if (!init || typeof init !== "object" || !("signal" in init)) return init;
  const { signal, ...rest } = init as { signal?: AbortSignal } & Record<string, unknown>;
  if (!signal) return rest;
  if (signal.aborted) throw abortError();
  return {
    ...rest,
    __onAbort: (cancel: () => void) => {
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", () => cancel(), { once: true });
    },
  };
}
