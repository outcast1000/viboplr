// Symmetric RPC over a MessagePort-like channel — the only link between a
// worker-runtime plugin and the host. See pluginWorker/host.ts for why the
// plugin lives in a worker at all.
//
// Functions cannot be structured-cloned, but the plugin API is full of them:
// handlers the plugin registers (onFetch, onTool, …), callbacks inside options
// (exec's onOutput/onStart), and functions the host hands back (unsubscribers,
// browse-window handles). Both ends therefore run the same endpoint: any
// function crossing the boundary is swapped for a `{ [FN]: id }` ref, and the
// receiving end turns the ref into a stub that calls back across. A stub always
// returns a Promise, which is why a synchronous API method cannot survive the
// crossing and needs a snapshot instead (see SYNC in host.ts).
//
// Every crossing mints a fresh id — ids are never reused for the same function.
// Reuse would race with release: the far side's stub for id N can be collected
// (posting `release N`) after we re-sent N, and the new stub would then point
// at a deleted entry.

export const FN = "__vfn";
/** Marks a synchronous API method the worker serves from the host's pushed
 *  snapshot instead of a round trip (see SYNC_PATHS in host.ts). */
export const SYNC = "__vsync";

/** Minimal surface of MessagePort / DedicatedWorkerGlobalScope / Worker. */
export interface RpcPort {
  postMessage(message: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

type Msg =
  | { t: "call"; id: number; fn: number; args: unknown[] }
  | { t: "ret"; id: number; ok: true; value: unknown }
  | { t: "ret"; id: number; ok: false; error: { name: string; message: string } }
  | { t: "release"; fn: number };

const MAX_DEPTH = 32;

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export interface RpcStats {
  callsOut: number;
  callsIn: number;
  liveLocalFns: number;
  pending: number;
}

export class RpcEndpoint {
  private readonly port: RpcPort;
  private readonly local = new Map<number, (...args: unknown[]) => unknown>();
  private nextFn = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextCall = 1;
  private closed = false;
  private callsOut = 0;
  private callsIn = 0;
  // A stub that is garbage-collected can never be called again, so the far
  // side may drop the function it points at. Without this, every exec
  // onOutput / onStart callback and every unsubscriber leaks for the life of
  // the plugin.
  private readonly finalizer =
    typeof FinalizationRegistry !== "undefined"
      ? new FinalizationRegistry<number>((fn) => this.send({ t: "release", fn }))
      : null;

  constructor(
    port: RpcPort,
    private readonly onOther?: (msg: unknown) => void,
    private readonly opts: { callableResults?: boolean } = {},
  ) {
    this.port = port;
    port.onmessage = (ev) => this.receive(ev.data);
  }

  /** Replace every function in `value` with a ref this endpoint can serve. */
  encode(value: unknown, depth = 0): unknown {
    if (typeof value === "function") {
      const id = this.nextFn++;
      this.local.set(id, value as (...args: unknown[]) => unknown);
      return { [FN]: id };
    }
    if (value === null || typeof value !== "object" || depth > MAX_DEPTH) return value;
    if (Array.isArray(value)) return value.map((v) => this.encode(v, depth + 1));
    // Class instances (Date, Map, ArrayBuffer, Error…) go to structured clone
    // as-is; only plain objects can hide functions we need to swap out.
    if (!isPlainObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = this.encode(v, depth + 1);
    return out;
  }

  /** Turn refs produced by the far side's `encode` back into callables. */
  decode(value: unknown, depth = 0): unknown {
    if (value === null || typeof value !== "object" || depth > MAX_DEPTH) return value;
    if (Array.isArray(value)) return value.map((v) => this.decode(v, depth + 1));
    if (!isPlainObject(value)) return value;
    const rec = value as Record<string, unknown>;
    if (typeof rec[FN] === "number" && Object.keys(rec).length === 1) return this.stub(rec[FN] as number);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = this.decode(v, depth + 1);
    return out;
  }

  stats(): RpcStats {
    return { callsOut: this.callsOut, callsIn: this.callsIn, liveLocalFns: this.local.size, pending: this.pending.size };
  }

  /** Fail everything in flight; later calls reject immediately. */
  close(reason = "plugin runtime stopped"): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
    this.local.clear();
    this.port.onmessage = null;
  }

  private stub(fn: number): (...args: unknown[]) => Promise<unknown> {
    const f = this.opts.callableResults
      ? (...args: unknown[]) => callablePromise(this.call(fn, args))
      : (...args: unknown[]) => this.call(fn, args);
    this.finalizer?.register(f, fn);
    return f;
  }

  private call(fn: number, args: unknown[]): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("plugin runtime stopped"));
    const id = this.nextCall++;
    this.callsOut++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ t: "call", id, fn, args: this.encode(args) as unknown[] });
      } catch (e) {
        // DataCloneError: an argument structured clone can't carry. Surface it
        // at the call site rather than leaving the promise hanging.
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private send(msg: Msg): void {
    if (this.closed) return;
    this.port.postMessage(msg);
  }

  private receive(data: unknown): void {
    const msg = data as Msg;
    switch (msg?.t) {
      case "call":
        void this.serve(msg);
        return;
      case "ret": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(this.decode(msg.value));
        else {
          const err = new Error(msg.error.message);
          err.name = msg.error.name;
          p.reject(err);
        }
        return;
      }
      case "release":
        this.local.delete(msg.fn);
        return;
      default:
        this.onOther?.(data);
    }
  }

  private async serve(msg: Extract<Msg, { t: "call" }>): Promise<void> {
    this.callsIn++;
    const fn = this.local.get(msg.fn);
    let value: unknown;
    try {
      if (!fn) throw new Error("function was released");
      value = await fn(...(this.decode(msg.args) as unknown[]));
    } catch (e) {
      this.fail(msg.id, e);
      return;
    }
    try {
      this.send({ t: "ret", id: msg.id, ok: true, value: this.encode(value) });
    } catch (e) {
      // The result itself isn't cloneable — report that instead of hanging.
      this.fail(msg.id, new Error(`result could not cross the plugin boundary: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  private fail(id: number, e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    this.send({ t: "ret", id, ok: false, error: { name: err.name, message: err.message } });
  }
}

/**
 * A Promise that can also be called. Registration methods in the plugin API
 * return their unsubscriber synchronously (`const off = api.x.onY(h); off()`),
 * but across the boundary every result is async. Returning this keeps that
 * code working: calling it waits for the real unsubscriber and runs it, while
 * `await` / `.then` / `.catch` still see an ordinary promise.
 */
export function callablePromise<T>(p: Promise<T>): Promise<T> & ((...args: unknown[]) => Promise<unknown>) {
  const f = ((...args: unknown[]) =>
    p.then((r) => (typeof r === "function" ? (r as (...a: unknown[]) => unknown)(...args) : undefined))) as
    Promise<T> & ((...args: unknown[]) => Promise<unknown>);
  f.then = p.then.bind(p) as typeof p.then;
  f.catch = p.catch.bind(p) as typeof p.catch;
  f.finally = p.finally.bind(p) as typeof p.finally;
  return f;
}
