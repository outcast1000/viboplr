// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { MessageChannel } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { RpcEndpoint, SYNC, callablePromise, type RpcPort } from "../pluginWorker/rpc";
import {
  PERMISSION_TABLE, PermissionError, checkPermission, describePermission, isGranted, networkHosts, pendingPermissions,
} from "../pluginWorker/permissions";
import { SYNC_PATHS, createSyncReader, gateApi } from "../pluginWorker/host";

// node:worker_threads ports deliver `message` events with the payload directly;
// adapt them to the browser MessagePort shape RpcEndpoint expects.
function browserPort(p: import("node:worker_threads").MessagePort): RpcPort {
  const port: RpcPort = {
    postMessage: (m) => p.postMessage(m),
    onmessage: null,
  };
  p.on("message", (data) => port.onmessage?.({ data } as MessageEvent));
  p.unref();
  return port;
}

function pair(): { host: RpcEndpoint; worker: RpcEndpoint; hostOther: unknown[] } {
  const { port1, port2 } = new MessageChannel();
  const hostOther: unknown[] = [];
  const host = new RpcEndpoint(browserPort(port1), (m) => hostOther.push(m));
  const worker = new RpcEndpoint(browserPort(port2), undefined, { callableResults: true });
  return { host, worker, hostOther };
}

/** Ship `value` host→worker the way host.ts ships the api at init. */
function ship(host: RpcEndpoint, worker: RpcEndpoint, value: unknown): unknown {
  return worker.decode(structuredClone(host.encode(value)));
}

describe("RpcEndpoint", () => {
  it("calls a host function from the worker and returns its value", async () => {
    const { host, worker } = pair();
    const api = ship(host, worker, { add: (a: number, b: number) => a + b }) as { add: (a: number, b: number) => Promise<number> };
    await expect(api.add(2, 3)).resolves.toBe(5);
  });

  it("passes worker callbacks to the host as callable stubs", async () => {
    const { host, worker } = pair();
    let registered: ((x: number) => Promise<unknown>) | null = null;
    const api = ship(host, worker, {
      onFetch: (h: (x: number) => Promise<unknown>) => { registered = h; },
    }) as { onFetch: (h: (x: number) => unknown) => Promise<void> };
    await api.onFetch((x) => ({ doubled: x * 2 }));
    expect(registered).not.toBeNull();
    await expect(registered!(21)).resolves.toEqual({ doubled: 42 });
  });

  it("rebuilds rejections as Errors with name and message", async () => {
    const { host, worker } = pair();
    const api = ship(host, worker, {
      fail: () => { throw new PermissionError("p", "network.fetch", "network:x.com"); },
    }) as { fail: () => Promise<void> };
    const err = await api.fail().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PermissionError");
    expect(err.message).toContain("network:x.com");
  });

  it("returns functions inside results as stubs (browse-window handles, unsubscribers)", async () => {
    const { host, worker } = pair();
    const closed = vi.fn();
    const api = ship(host, worker, {
      open: async () => ({ id: 7, close: () => { closed(); return true; } }),
    }) as { open: () => Promise<{ id: number; close: () => Promise<boolean> }> };
    const handle = await api.open();
    expect(handle.id).toBe(7);
    await expect(handle.close()).resolves.toBe(true);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("keeps sync-returned unsubscribers callable on the worker side", async () => {
    const { host, worker } = pair();
    const unsub = vi.fn();
    const api = ship(host, worker, { onEvent: () => unsub }) as { onEvent: (h: () => void) => () => Promise<unknown> };
    const off = api.onEvent(() => {});
    await off();
    expect(unsub).toHaveBeenCalledOnce();
  });

  it("rejects everything in flight when closed", async () => {
    const { host, worker } = pair();
    const api = ship(host, worker, { never: () => new Promise(() => {}) }) as { never: () => Promise<void> };
    const p = api.never();
    worker.close("stopped");
    await expect(p).rejects.toThrow("stopped");
    await expect(api.never()).rejects.toThrow();
  });

  it("forwards non-RPC messages to onOther", async () => {
    const { port1, port2 } = new MessageChannel();
    const seen: unknown[] = [];
    new RpcEndpoint(browserPort(port1), (m) => seen.push(m));
    port2.postMessage({ t: "ready", control: {} });
    await new Promise((r) => setTimeout(r, 20));
    port2.close();
    expect(seen).toEqual([{ t: "ready", control: {} }]);
  });
});

describe("callablePromise", () => {
  it("awaits like a promise and calls through like a function", async () => {
    const inner = vi.fn(() => "done");
    const cp = callablePromise(Promise.resolve(inner));
    expect(await cp).toBe(inner);
    await expect(cp("a")).resolves.toBe("done");
    expect(inner).toHaveBeenCalledWith("a");
  });
});

describe("permissions", () => {
  it("matches hosts exactly, by *. suffix, or with *", () => {
    expect(isGranted(["network:lrclib.net"], "network:lrclib.net")).toBe(true);
    expect(isGranted(["network:lrclib.net"], "network:evil.net")).toBe(false);
    expect(isGranted(["network:*.deezer.com"], "network:api.deezer.com")).toBe(true);
    expect(isGranted(["network:*.deezer.com"], "network:deezer.com")).toBe(false);
    expect(isGranted(["network:*.deezer.com"], "network:notdeezer.com")).toBe(false);
    expect(isGranted(["network:*"], "network:anything.io")).toBe(true);
    // A browse grant is not a network grant.
    expect(isGranted(["browse:*"], "network:x.com")).toBe(false);
  });

  it("never grants non-http or unparseable URLs", () => {
    expect(() => checkPermission("p", ["network:*"], "network.fetch", ["file:///etc/passwd"])).toThrow(PermissionError);
    expect(() => checkPermission("p", ["network:*"], "network.fetch", ["not a url"])).toThrow(PermissionError);
  });

  it("gates env on the named variable", () => {
    expect(() => checkPermission("p", ["env:LASTFM_API_KEY"], "env.get", ["LASTFM_API_KEY"])).not.toThrow();
    expect(() => checkPermission("p", ["env:LASTFM_API_KEY"], "env.get", ["AWS_SECRET_ACCESS_KEY"])).toThrow(/env:AWS_SECRET_ACCESS_KEY/);
  });

  it("splits cue sheet reads from writes", () => {
    expect(() => checkPermission("p", [], "cues.list", [])).toThrow(/cues:read/);
    expect(() => checkPermission("p", ["cues:read"], "cues.get", ["Song", "Artist"])).not.toThrow();
    expect(() => checkPermission("p", ["cues:read"], "cues.set", ["Song", "Artist", {}])).toThrow(/cues:write/);
    expect(() => checkPermission("p", ["cues:write"], "cues.delete", ["Song"])).not.toThrow();
    expect(describePermission("cues:write").label).toBe("Change your cue sheets");
  });

  it("saving lyrics needs lyrics:write", () => {
    expect(() => checkPermission("p", ["library:write"], "lyrics.save", [{ title: "Song" }, { text: "x", kind: "plain" }])).toThrow(/lyrics:write/);
    expect(() => checkPermission("p", ["lyrics:write"], "lyrics.save", [{ title: "Song" }, { text: "x", kind: "plain" }])).not.toThrow();
    expect(describePermission("lyrics:write").label).toBe("Change song lyrics");
  });

  it("gates exec on the named binary", () => {
    expect(() => checkPermission("p", ["exec:yt-dlp"], "system.exec", ["yt-dlp", []])).not.toThrow();
    expect(() => checkPermission("p", ["exec:yt-dlp"], "system.exec", ["ffmpeg", []])).toThrow(/exec:ffmpeg/);
  });

  it("is fail-closed for methods missing from the table", () => {
    expect(() => checkPermission("p", ["network:*"], "library.dropEverything", [])).toThrow(/no permission defined/);
  });

  it("allows plugin-scoped methods with no permissions at all", () => {
    expect(() => checkPermission("p", [], "storage.get", ["k"])).not.toThrow();
    expect(() => checkPermission("p", [], "informationTypes.onFetch", ["lyrics", () => {}])).not.toThrow();
  });

  it("hands Rust exactly the network grants, lowercased", () => {
    expect(networkHosts(["network:LRCLIB.net", "exec:yt-dlp", "network:*.deezer.com", "browse:*"])).toEqual([
      "lrclib.net",
      "*.deezer.com",
    ]);
    expect(networkHosts([])).toEqual([]);
  });

  // Fail-closed means a new API method is denied to worker plugins until it
  // gets a row here — so adding one to ViboplrPluginAPI without a row must
  // fail this test, not a plugin in the field. Parsed from the real types.
  it("has a row for every method of the plugin API", () => {
    const types = readFileSync(new URL("../types/plugin.ts", import.meta.url), "utf8");
    const iface = (name: string) =>
      new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(types)?.[1] ?? "";
    const found = new Set<string>(["log"]);
    const walk = (name: string, prefix: string) => {
      for (const m of iface(name).matchAll(/^ {2}(\w+)\??(?:<[^>]*>)?(\(|:\s*(\w+API);)/gm)) {
        if (m[2] === "(") found.add(`${prefix}.${m[1]}`);
        else if (m[3]) walk(m[3], `${prefix}.${m[1]}`);
      }
    };
    for (const m of iface("ViboplrPluginAPI").matchAll(/^\s+(\w+)\??:\s*(Plugin\w+API);/gm)) {
      if (m[1] !== "visualizers") walk(m[2], m[1]); // visualizers: gated as a whole namespace
    }
    expect(found.size).toBeGreaterThan(100); // the parse found the API at all
    const missing = [...found].filter((p) => !(p in PERMISSION_TABLE));
    expect(missing).toEqual([]);
  });

  it("covers every sync getter", () => {
    for (const path of SYNC_PATHS) expect(path in PERMISSION_TABLE).toBe(true);
  });
});

describe("consent", () => {
  it("nothing is pending once everything requested was approved", () => {
    expect(pendingPermissions(["network:lrclib.net"], ["network:lrclib.net"])).toEqual([]);
    expect(pendingPermissions([], [])).toEqual([]);
  });

  it("an update asking for more puts only the new permissions up for approval", () => {
    expect(pendingPermissions(["network:lrclib.net", "exec:yt-dlp"], ["network:lrclib.net"])).toEqual(["exec:yt-dlp"]);
  });

  it("an old approval never widens what the current manifest asks for", () => {
    // Approved exec before; this version dropped it. Nothing is pending, and
    // the gate still only receives the manifest's own list.
    expect(pendingPermissions(["network:lrclib.net"], ["network:lrclib.net", "exec:yt-dlp"])).toEqual([]);
  });

  it("de-duplicates a manifest that lists a permission twice", () => {
    expect(pendingPermissions(["env", "env"], [])).toEqual(["env"]);
  });

  it("describes every permission in the vocabulary without echoing the raw string", () => {
    const vocab = [
      "network:lrclib.net", "browse:accounts.spotify.com", "exec:yt-dlp", "library:read", "library:write",
      "files:read", "files:trash", "playback:read", "playback:control", "system:open", "env:LASTFM_API_KEY", "plugins:call",
    ];
    for (const perm of vocab) {
      const d = describePermission(perm);
      expect(d.label).not.toBe(perm);
      expect(d.detail.length).toBeGreaterThan(0);
    }
  });

  it("marks the permissions that reach outside the app or change data as sensitive", () => {
    for (const perm of ["exec:yt-dlp", "library:write", "files:trash", "env:API_KEY", "browse:x.com", "network:*"]) {
      expect(describePermission(perm).sensitive, perm).toBe(true);
    }
    for (const perm of ["network:lrclib.net", "library:read", "playback:read", "plugins:call"]) {
      expect(describePermission(perm).sensitive, perm).toBe(false);
    }
  });

  it("names hosts the way a person would read them", () => {
    expect(describePermission("network:*").label).toBe("Connect to any website");
    expect(describePermission("network:*.deezer.com").label).toBe("Connect to any deezer.com address");
    expect(describePermission("network:lrclib.net").label).toBe("Connect to lrclib.net");
  });

  it("says plainly when it doesn't recognise a permission", () => {
    expect(describePermission("teleport:mars").detail).toMatch(/not recognised/i);
  });
});

describe("createSyncReader", () => {
  const track = { title: "t" };
  const queue = { tracks: [track], index: 0 };
  const api = {
    playback: {
      getCurrentTrack: () => track,
      isPlaying: () => true,
      getPosition: () => 12,
      getQueue: () => queue,
    },
    search: { listProviders: () => [{ key: "a:b" }] },
    plugins: { list: () => [{ id: "a" }] },
  };

  it("sends everything first, then only what changed", () => {
    const read = createSyncReader("p", ["playback:read", "plugins:call"], api);
    expect(Object.keys(read(true)).sort()).toEqual([...SYNC_PATHS].sort());
    expect(read(false)).toEqual({});
  });

  it("does not re-send a denied getter every tick", () => {
    // No grants at all: every sync path is denied.
    const read = createSyncReader("p", [], api);
    const first = read(true);
    expect((first["playback.getQueue"] as { __denied: string }).__denied).toMatch(/playback:read/);
    for (let i = 0; i < 5; i++) expect(read(false)).toEqual({});
  });

  it("reports a change of value by identity", () => {
    let pos = 1;
    const live = { ...api, playback: { ...api.playback, getPosition: () => pos } };
    const read = createSyncReader("p", ["playback:read", "plugins:call"], live);
    read(true);
    pos = 2;
    expect(read(false)).toEqual({ "playback.getPosition": 2 });
  });
});

describe("gateApi", () => {
  const api = {
    appVersion: "1.2.3",
    storage: { get: vi.fn(async () => "v") },
    network: {
      fetch: vi.fn(async () => ({
        status: 200, headers: {}, url: "https://lrclib.net/x",
        text: async () => "body", json: async () => ({}), getSetCookie: () => ["a=1"],
      })),
    },
    playback: { getQueue: () => ({ tracks: [], index: 0 }) },
    visualizers: { register: () => {} },
  };

  it("denies and reports calls outside the grant", async () => {
    const denied: PermissionError[] = [];
    const g = gateApi("p", [], api, (e) => denied.push(e)) as any;
    await expect(g.network.fetch("https://lrclib.net/api")).rejects.toThrow(PermissionError);
    expect(denied).toHaveLength(1);
    expect(api.network.fetch).not.toHaveBeenCalled();
  });

  it("materializes fetch responses as plain data", async () => {
    const g = gateApi("p", ["network:lrclib.net"], api, () => {}) as any;
    await expect(g.network.fetch("https://lrclib.net/api")).resolves.toEqual({
      status: 200, headers: {}, url: "https://lrclib.net/x", body: "body", setCookie: ["a=1"],
    });
  });

  it("turns sync getters into snapshot markers and blocks visualizers", () => {
    const g = gateApi("p", [], api, () => {}) as any;
    expect(g.playback.getQueue).toEqual({ [SYNC]: "playback.getQueue" });
    expect(() => g.visualizers.register()).toThrow(/not available to worker-runtime plugins/);
    expect(g.appVersion).toBe("1.2.3");
  });

  it("result is structured-cloneable once encoded (no functions left)", () => {
    const { host } = pair();
    const g = gateApi("p", [], api, () => {});
    expect(() => structuredClone(host.encode(g))).not.toThrow();
  });
});
