// Host side of the worker plugin runtime (prototype; opt-in via manifest
// `"runtime": "worker"`).
//
// Why: a main-realm plugin runs in the app's own global scope. The frozen
// sandbox only renames a few globals, so a plugin can reach
// `__TAURI_INTERNALS__.invoke` (every Tauri command), the real `window` via
// `(function(){}).constructor("return globalThis")()`, and other plugins'
// objects. Manifest fields like `apiUsage` are advisory. A worker has none of
// that: Tauri never injects its IPC (or its invoke key) into workers, so the
// plugin's only channel is the MessagePort this bridge owns. Identity is the
// port, not a claim the plugin makes, and every call is checked against
// `manifest.permissions` here before it reaches the real API.
//
// The API itself is not reimplemented: the bridge wraps the same object
// `buildAPI` produces for main-realm plugins, so both runtimes run identical
// host code behind the gate.

import { RpcEndpoint, SYNC } from "./rpc";
import { checkPermission, PermissionError } from "./permissions";

/**
 * API methods that are synchronous in the contract and so cannot be a round
 * trip. The worker serves them from a snapshot this bridge pushes whenever the
 * host value changes (checked every SYNC_INTERVAL_MS), so they can be up to one
 * interval stale — e.g. `getPosition()` advances in SYNC_INTERVAL_MS steps.
 */
export const SYNC_PATHS = [
  "playback.getCurrentTrack",
  "playback.isPlaying",
  "playback.getPosition",
  "playback.getQueue",
  "search.listProviders",
  "plugins.list",
] as const;
const SYNC_INTERVAL_MS = 250;
/** Worker spawn + plugin source evaluation, before activate() even starts. */
const READY_TIMEOUT_MS = 10000;
const DEACTIVATE_TIMEOUT_MS = 1000;

type AnyFn = (...args: unknown[]) => unknown;
type ApiTree = Record<string, unknown>;

function isPlainObject(v: unknown): v is ApiTree {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function lookup(api: ApiTree, path: string): unknown {
  let o: unknown = api;
  let parent: unknown = undefined;
  for (const part of path.split(".")) {
    parent = o;
    o = isPlainObject(o) ? o[part] : undefined;
  }
  return typeof o === "function" ? (o as AnyFn).bind(parent) : o;
}

/**
 * The API as the worker sees it: every method goes through `checkPermission`,
 * sync getters become snapshot markers, and namespaces the worker runtime can't
 * support yet become methods that reject with a clear reason.
 */
export function gateApi(
  pluginId: string,
  granted: readonly string[],
  api: ApiTree,
  onDenied: (e: PermissionError) => void,
): ApiTree {
  const walk = (obj: ApiTree, prefix: string): ApiTree => {
    const out: ApiTree = {};
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (path === "visualizers") {
        // Visualizers are handed a live ShadowRoot, which a worker has no DOM
        // for. Their worker model (OffscreenCanvas vs sandboxed iframe) is TBD.
        const reason = "api.visualizers is not available to worker-runtime plugins yet";
        out[key] = isPlainObject(value)
          ? Object.fromEntries(Object.keys(value).map((k) => [k, () => { throw new Error(reason); }]))
          : value;
        continue;
      }
      if (typeof value === "function") {
        if ((SYNC_PATHS as readonly string[]).includes(path)) {
          out[key] = { [SYNC]: path };
          continue;
        }
        const fn = value as AnyFn;
        const gated = (...args: unknown[]) => {
          try {
            checkPermission(pluginId, granted, path, args);
          } catch (e) {
            if (e instanceof PermissionError) onDenied(e);
            throw e;
          }
          return fn.apply(obj, args);
        };
        out[key] = path === "network.fetch" ? materializeFetch(gated) : gated;
      } else if (isPlainObject(value)) {
        out[key] = walk(value, path);
      } else {
        out[key] = value;
      }
    }
    return out;
  };
  return walk(api, "");
}

/**
 * `api.network.fetch` resolves to an object with a *synchronous*
 * `getSetCookie()`, which a stub can't provide. Read the whole response on the
 * host and ship plain data; the worker runtime rebuilds the response object.
 */
function materializeFetch(fetchFn: AnyFn): AnyFn {
  return async (...args: unknown[]) => {
    const resp = (await fetchFn(...args)) as {
      status: number; headers: Record<string, string>; url?: string;
      text(): Promise<string>; getSetCookie(): string[];
    };
    return {
      status: resp.status,
      headers: resp.headers,
      url: resp.url,
      body: await resp.text(),
      setCookie: resp.getSetCookie(),
    };
  };
}

/**
 * Reads the sync getters (SYNC_PATHS) and reports what changed since the last
 * read — the snapshot the host pushes to a worker. Values keep their host
 * identity while unchanged (queueRef.current etc.), so most reads cost a few
 * reference compares and report nothing. A getter the plugin isn't granted
 * reports one `{ __denied }` marker, built once and reused: a fresh object per
 * read never compares equal, which re-sent every denied path on every tick.
 */
export function createSyncReader(
  pluginId: string,
  permissions: readonly string[],
  api: ApiTree,
): (all: boolean) => Record<string, unknown> {
  const last = new Map<string, unknown>();
  const denied = new Map<string, { __denied: string }>();
  return (all) => {
    const changed: Record<string, unknown> = {};
    for (const path of SYNC_PATHS) {
      let value: unknown;
      try {
        checkPermission(pluginId, permissions, path, []);
        value = (lookup(api, path) as AnyFn | undefined)?.();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        let marker = denied.get(path);
        if (!marker || marker.__denied !== message) {
          marker = { __denied: message };
          denied.set(path, marker);
        }
        value = marker;
      }
      const prev = last.get(path);
      const same =
        prev === value ||
        // Freshly built each call; compare by content so they don't resend.
        ((path === "search.listProviders" || path === "plugins.list") && JSON.stringify(prev) === JSON.stringify(value));
      if (all || !same) {
        changed[path] = value;
        last.set(path, value);
      }
    }
    return changed;
  };
}

export interface WorkerPluginControl {
  activate(): Promise<unknown>;
  deactivate(): Promise<void>;
  stats(): Promise<unknown>;
  /** Hard stop: kill the worker, reject everything in flight. */
  terminate(): void;
  /** Spawn → ready (worker boot + plugin source evaluated). */
  readyMs: number;
}

export interface StartWorkerPluginOptions {
  pluginId: string;
  code: string;
  permissions: readonly string[];
  api: ApiTree;
  onDenied: (e: PermissionError) => void;
  /** Debug-only probes for measuring the bridge itself (see bench plugins). */
  bench?: boolean;
  /** Failures the plugin didn't handle inside its worker (see runtime.ts). */
  onWorkerLog?: (level: string, message: string) => void;
}

function spawnWorker(pluginId: string): Worker {
  return new Worker(new URL("./runtime.ts", import.meta.url), {
    type: "module",
    name: `plugin:${pluginId}`,
  });
}

/** Workers created ahead of activation, keyed by plugin id — see prewarmPluginWorkers. */
const prewarmed = new Map<string, Worker>();
/**
 * A prewarmed worker that failed to boot before its plugin claimed it. Its
 * error event fires with nobody listening yet, so it is recorded here — without
 * it the claim would post `init` into a dead worker and wait out the full
 * READY_TIMEOUT_MS, once per worker plugin, back to back.
 */
const bootErrors = new Map<string, string>();

/**
 * Start booting the workers for these plugins now, all at once. Most of a
 * worker plugin's activation cost is the worker loading and evaluating the
 * runtime module, which happens off the main thread as soon as the Worker is
 * constructed — so creating them together overlaps that work instead of paying
 * it once per plugin inside the (deliberately sequential) activation loop.
 * A worker is idle until `startWorkerPlugin` sends it `init`, so an unused one
 * costs only its memory; `dropPrewarmedWorkers` reclaims any that were never
 * claimed.
 */
export function prewarmPluginWorkers(pluginIds: readonly string[]): void {
  for (const id of pluginIds) {
    if (prewarmed.has(id)) continue;
    const worker = spawnWorker(id);
    worker.onerror = (ev) => {
      bootErrors.set(id, ev.message || "plugin worker failed to start");
    };
    prewarmed.set(id, worker);
  }
}

/** Terminate prewarmed workers no activation claimed (e.g. one that errored before startWorkerPlugin). */
export function dropPrewarmedWorkers(): void {
  for (const w of prewarmed.values()) w.terminate();
  prewarmed.clear();
  bootErrors.clear();
}

export async function startWorkerPlugin(opts: StartWorkerPluginOptions): Promise<WorkerPluginControl> {
  const t0 = performance.now();
  const warm = prewarmed.get(opts.pluginId);
  prewarmed.delete(opts.pluginId);
  const bootError = bootErrors.get(opts.pluginId);
  bootErrors.delete(opts.pluginId);
  if (warm && bootError !== undefined) {
    warm.terminate();
    throw new Error(bootError);
  }
  const worker = warm ?? spawnWorker(opts.pluginId);

  let settleReady: ((control: unknown) => void) | null = null;
  let failReady: ((e: Error) => void) | null = null;
  const ready = new Promise<unknown>((resolve, reject) => {
    settleReady = resolve;
    failReady = reject;
  });

  const endpoint = new RpcEndpoint(worker, (msg) => {
    const m = msg as { t?: string; control?: unknown; error?: { name: string; message: string } };
    if (m?.t === "ready") settleReady?.(endpoint.decode(m.control));
    else if (m?.t === "failed") failReady?.(new Error(m.error?.message ?? "plugin failed to load"));
    else if (m?.t === "log") {
      const l = msg as { level?: string; message?: string };
      opts.onWorkerLog?.(String(l.level ?? "error"), String(l.message ?? ""));
    }
  });
  worker.onerror = (ev) => {
    console.error(`[plugin:${opts.pluginId}] worker error:`, ev.message);
    failReady?.(new Error(ev.message || "plugin worker crashed"));
  };

  const gated = gateApi(opts.pluginId, opts.permissions, opts.api, opts.onDenied);
  if (opts.bench) {
    // Outside the permission table on purpose: these measure the bridge, not
    // the API. `echo` is one worker→host round trip; `bounce` adds a
    // host→worker call inside it.
    gated.__bench = {
      echo: (x: unknown) => x,
      bounce: (cb: AnyFn) => cb(),
    };
  }

  const readSync = createSyncReader(opts.pluginId, opts.permissions, opts.api);

  worker.postMessage({
    t: "init",
    pluginId: opts.pluginId,
    code: opts.code,
    api: endpoint.encode(gated),
    syncValues: readSync(true),
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let control: { activate: AnyFn; deactivate: AnyFn; stats: AnyFn };
  try {
    control = (await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`plugin worker not ready after ${READY_TIMEOUT_MS}ms`)), READY_TIMEOUT_MS);
      }),
    ])) as typeof control;
  } catch (e) {
    worker.terminate();
    endpoint.close();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const readyMs = performance.now() - t0;

  const syncTimer = setInterval(() => {
    const changed = readSync(false);
    if (Object.keys(changed).length === 0) return;
    try {
      worker.postMessage({ t: "sync", values: changed });
    } catch (e) {
      console.error(`[plugin:${opts.pluginId}] failed to push playback snapshot:`, e);
    }
  }, SYNC_INTERVAL_MS);

  let stopped = false;
  const terminate = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(syncTimer);
    worker.terminate();
    endpoint.close();
  };

  return {
    readyMs,
    activate: () => Promise.resolve(control.activate()),
    stats: async () => ({ host: endpoint.stats(), worker: await control.stats() }),
    terminate,
    async deactivate() {
      if (stopped) return;
      let t: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve(control.deactivate()),
          new Promise((resolve) => { t = setTimeout(resolve, DEACTIVATE_TIMEOUT_MS); }),
        ]);
      } catch (e) {
        console.error(`[plugin:${opts.pluginId}] deactivate error:`, e);
      } finally {
        clearTimeout(t);
        terminate();
      }
    },
  };
}
