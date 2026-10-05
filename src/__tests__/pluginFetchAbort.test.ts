// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { MessageChannel } from "node:worker_threads";
import { RpcEndpoint, type RpcPort } from "../pluginWorker/rpc";
import { FETCH_ABORTED, abortError, armFetchAbort, isFetchAborted, workerFetchInit } from "../utils/pluginFetchAbort";

function browserPort(p: import("node:worker_threads").MessagePort): RpcPort {
  const port: RpcPort = { postMessage: (m) => p.postMessage(m), onmessage: null };
  p.on("message", (data) => port.onmessage?.({ data } as MessageEvent));
  p.unref();
  return port;
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("armFetchAbort", () => {
  it("is a no-op without a cancel source", () => {
    expect(armFetchAbort("p", undefined, vi.fn())).toBeNull();
    expect(armFetchAbort("p", { }, vi.fn())).toBeNull();
  });

  it("cancels by request id when the signal aborts", () => {
    const cancel = vi.fn();
    const ctl = new AbortController();
    const armed = armFetchAbort("llm", { signal: ctl.signal }, cancel)!;
    expect(armed.requestId).toMatch(/^llm:/);
    ctl.abort();
    expect(cancel).toHaveBeenCalledWith(armed.requestId);
  });

  it("sends nothing for an abort after the request settled", () => {
    const cancel = vi.fn();
    const ctl = new AbortController();
    armFetchAbort("p", { signal: ctl.signal }, cancel)!.settle();
    ctl.abort();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("refuses an already-aborted signal before anything is sent", () => {
    const ctl = new AbortController();
    ctl.abort();
    expect(() => armFetchAbort("p", { signal: ctl.signal }, vi.fn())).toThrow(expect.objectContaining({ name: "AbortError" }));
  });

  it("gives every request its own id", () => {
    const a = armFetchAbort("p", { signal: new AbortController().signal }, vi.fn())!;
    const b = armFetchAbort("p", { signal: new AbortController().signal }, vi.fn())!;
    expect(a.requestId).not.toBe(b.requestId);
  });
});

describe("isFetchAborted", () => {
  it("recognises the backend's sentinel only", () => {
    expect(isFetchAborted(FETCH_ABORTED)).toBe(true);
    expect(isFetchAborted("connection refused")).toBe(false);
    expect(abortError().name).toBe("AbortError");
  });
});

describe("worker → host cancel", () => {
  it("an abort in the worker cancels the host request and rejects with AbortError", async () => {
    // The real shape: worker code holds the signal, the host holds the request.
    const { port1, port2 } = new MessageChannel();
    const host = new RpcEndpoint(browserPort(port1));
    const worker = new RpcEndpoint(browserPort(port2), undefined, { callableResults: true });
    const cancelled: string[] = [];
    const hostApi = {
      fetch: (_url: string, init?: Parameters<typeof armFetchAbort>[1]) =>
        new Promise((resolve, reject) => {
          const armed = armFetchAbort("llm", init, (id) => {
            cancelled.push(id);
            reject(abortError()); // what Rust's FETCH_ABORTED becomes
          });
          setTimeout(() => { armed?.settle(); resolve("late answer"); }, 2000);
        }),
    };
    const api = worker.decode(structuredClone(host.encode(hostApi))) as { fetch: (u: string, i: unknown) => Promise<unknown> };

    const ctl = new AbortController();
    // A raw signal would fail structuredClone; the runtime swaps it first.
    const pending = api.fetch("http://model/chat", workerFetchInit({ method: "POST", signal: ctl.signal }));
    await tick();
    ctl.abort();
    const err = (await pending.catch((e: unknown) => e)) as Error;
    expect(err.name).toBe("AbortError");
    expect(cancelled).toHaveLength(1);
  });

  it("leaves an init without a signal untouched", () => {
    const init = { method: "GET" };
    expect(workerFetchInit(init)).toBe(init);
  });
});
