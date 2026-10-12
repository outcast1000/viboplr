// The bundled Last.fm plugin's love/unlove sync runs off `like:changed`
// (`api.library.onLikeChanged`): becoming liked is a love, leaving liked — to
// neutral OR to disliked, the single like button's next step — an unlove, and
// neutral ↔ disliked nothing. Runs the real plugin source against a stub API.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LikeChange } from "../types/plugin";

type Handler = (change: LikeChange) => unknown;

const posts: string[] = [];
let onLikeChanged: Handler | null = null;

/** Any API path the test doesn't care about: a callable that resolves to null. */
function anything(): unknown {
  const fn = () => Promise.resolve(null);
  return new Proxy(fn, { get: (_t, prop) => (prop === "then" ? undefined : anything()) });
}

function stubApi() {
  const api = {
    appVersion: "9.9.9",
    log: () => {},
    env: { get: async () => "test-key" },
    storage: {
      get: async (key: string) => (key === "lastfm_session" ? { sessionKey: "sk-test", username: "alice" } : null),
      set: async () => {},
      delete: async () => {},
    },
    network: {
      fetch: async (_url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST" && init.body) posts.push(init.body);
        return { status: 200, json: async () => ({}), text: async () => "{}" };
      },
    },
    library: { onLikeChanged: (h: Handler) => { onLikeChanged = h; return () => {}; } },
  } as Record<string, unknown>;
  // Every namespace falls back to `anything()` for the methods it doesn't define.
  const withFallback = (o: Record<string, unknown>) =>
    new Proxy(o, { get: (t, prop: string) => (prop in t ? t[prop] : anything()) });
  for (const k of Object.keys(api)) {
    const v = api[k];
    if (v && typeof v === "object") api[k] = withFallback(v as Record<string, unknown>);
  }
  return withFallback(api);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function change(liked: number, previous: number, kind: LikeChange["kind"] = "track"): LikeChange {
  return { kind, name: "Jóga", artistName: "Björk", albumTitle: "Homogenic", albumArtistName: "Björk", liked, previous };
}

async function sent(c: LikeChange): Promise<string | null> {
  posts.length = 0;
  onLikeChanged!(c);
  await flush();
  const body = posts[0];
  return body ? new URLSearchParams(body).get("method") : null;
}

beforeAll(async () => {
  const source = readFileSync(resolve(process.cwd(), "src-tauri/plugins/lastfm/index.js"), "utf8");
  const plugin = new Function("api", source)(undefined) as { activate: (api: unknown) => void };
  plugin.activate(stubApi());
  for (let i = 0; i < 5; i++) await flush(); // let the session restore
});

describe("Last.fm love sync (like:changed)", () => {
  it("subscribes to like:changed — there is no track:liked any more", () => {
    expect(typeof onLikeChanged).toBe("function");
  });

  it("loves on becoming liked, from neutral or from disliked", async () => {
    expect(await sent(change(1, 0))).toBe("track.love");
    expect(await sent(change(1, -1))).toBe("track.love");
  });

  it("unloves on leaving liked — including liked → disliked, the single button's next step", async () => {
    expect(await sent(change(0, 1))).toBe("track.unlove");
    expect(await sent(change(-1, 1))).toBe("track.unlove");
  });

  it("sends nothing between neutral and disliked, or for non-tracks", async () => {
    expect(await sent(change(0, -1))).toBeNull();
    expect(await sent(change(-1, 0))).toBeNull();
    expect(await sent(change(1, 0, "artist"))).toBeNull();
  });
});
