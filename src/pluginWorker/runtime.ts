/// <reference lib="webworker" />
// Entry point of a worker-runtime plugin. Runs in its own Web Worker, so the
// plugin shares no realm with the host: no `__TAURI_INTERNALS__`, no DOM, no
// host objects, no other plugin. Its only way out is the `api` proxy built here
// from what the host bridge (host.ts) sends, and every call on it is checked
// against the manifest's permissions on the host side before it runs.

import { RpcEndpoint, SYNC, type RpcPort } from "./rpc";

declare const self: DedicatedWorkerGlobalScope;

/**
 * Worker globals that reach the outside world without going through `api`.
 * Tauri's IPC is already out of reach (the page's invoke key is never injected
 * into workers), but these would let a plugin skip the network permission, spawn
 * a fresh worker with them restored, or talk to other plugins directly.
 * `import()` is syntax and can't be removed this way; that needs a CSP.
 */
const REMOVED_GLOBALS = [
  "fetch", "XMLHttpRequest", "WebSocket", "WebTransport", "EventSource",
  "importScripts", "Worker", "SharedWorker", "BroadcastChannel",
  "indexedDB", "caches",
];

function removeGlobal(name: string): void {
  // Walk the prototype chain: these live on WorkerGlobalScope.prototype (or
  // further up), and deleting only the own property leaves the inherited one.
  let o: object | null = self;
  while (o) {
    if (Object.prototype.hasOwnProperty.call(o, name)) {
      try {
        delete (o as Record<string, unknown>)[name];
      } catch (e) {
        console.error(`[plugin-runtime] could not remove ${name}:`, e);
      }
    }
    o = Object.getPrototypeOf(o);
  }
  if (name in self) {
    // Non-configurable somewhere: shadow it instead so a plain reference fails.
    Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false });
  }
}

interface InitMessage {
  t: "init";
  pluginId: string;
  code: string;
  api: unknown;
  syncValues: Record<string, unknown>;
}

const syncValues: Record<string, unknown> = {};

/** Replace `{ [SYNC]: path }` markers with getters reading the host's snapshot. */
function bindSync(value: unknown): unknown {
  if (value === null || typeof value !== "object" || typeof value === "function") return value;
  const rec = value as Record<string, unknown>;
  if (typeof rec[SYNC] === "string") {
    const path = rec[SYNC] as string;
    return () => {
      const v = syncValues[path];
      if (v && typeof v === "object" && "__denied" in (v as object)) {
        throw new Error((v as { __denied: string }).__denied);
      }
      return v;
    };
  }
  for (const k of Object.keys(rec)) rec[k] = bindSync(rec[k]);
  return rec;
}

/** host.ts ships `api.network.fetch` results as plain data (see
 *  materializeFetch); give the plugin back the response object it expects. */
function rebuildFetch(api: Record<string, unknown>): void {
  const network = api.network as Record<string, unknown> | undefined;
  const raw = network?.fetch as ((...a: unknown[]) => Promise<unknown>) | undefined;
  if (!network || typeof raw !== "function") return;
  network.fetch = async (...args: unknown[]) => {
    const r = (await raw(...args)) as {
      status: number; headers: Record<string, string>; url?: string; body: string; setCookie: string[];
    };
    return {
      status: r.status,
      headers: r.headers,
      url: r.url,
      getSetCookie: () => r.setCookie.slice(),
      text: async () => r.body,
      json: async () => JSON.parse(r.body),
    };
  };
}

/**
 * Report failures the plugin never handles. Inside a worker they go to the
 * worker's own console and nowhere else — a plugin whose permission-denied
 * call it forgot to await, or whose handler threw, would otherwise look
 * healthy from the host. The host writes these into the plugin log.
 */
function reportUnhandled(): void {
  const send = (message: string) => {
    try {
      self.postMessage({ t: "log", level: "error", message });
    } catch (e) {
      console.error("[plugin-runtime] could not report an error to the host:", e);
    }
  };
  self.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    send(`Unhandled rejection: ${r instanceof Error ? `${r.name}: ${r.message}` : String(r)}`);
  });
  self.addEventListener("error", (ev) => {
    send(`Uncaught error: ${ev.message}`);
  });
}

function start(init: InitMessage, endpoint: RpcEndpoint): void {
  Object.assign(syncValues, init.syncValues);
  const api = bindSync(endpoint.decode(init.api)) as Record<string, unknown>;
  rebuildFetch(api);

  for (const name of REMOVED_GLOBALS) removeGlobal(name);
  reportUnhandled();

  let exports: { activate?: (api: unknown) => unknown; deactivate?: () => unknown } | undefined;
  try {
    // Same factory contract as the main-realm loader: the source is a function
    // body that returns { activate, deactivate }. `window` is the worker scope
    // itself (timers, console, Math…) and there is no document.
    const factory = new Function("api", "window", "globalThis", "self", "document", init.code);
    exports = factory(api, self, self, self, undefined);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    self.postMessage({ t: "failed", error: { name: err.name, message: err.message } });
    return;
  }

  self.postMessage({
    t: "ready",
    control: endpoint.encode({
      activate: () => (typeof exports?.activate === "function" ? exports.activate(api) : undefined),
      deactivate: () => (typeof exports?.deactivate === "function" ? exports.deactivate() : undefined),
      stats: () => endpoint.stats(),
    }),
  });
}

const endpoint: RpcEndpoint = new RpcEndpoint(
  self as unknown as RpcPort,
  (msg) => {
    const m = msg as { t?: string };
    if (m?.t === "init") start(msg as InitMessage, endpoint);
    else if (m?.t === "sync") Object.assign(syncValues, (msg as { values: Record<string, unknown> }).values);
  },
  { callableResults: true },
);
