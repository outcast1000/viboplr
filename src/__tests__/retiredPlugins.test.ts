import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RETIRED_PLUGIN_IDS,
  withoutRetiredContributions,
  withoutRetiredIds,
  withoutRetiredKeys,
} from "../utils/retiredPlugins";

describe("retired plugins", () => {
  it("drops the retired ids from the enabled list, and says so only when there were any", () => {
    expect(withoutRetiredIds(["lastfm", "youtube", "ytdlp", "tidal-browse"])).toEqual(["lastfm", "ytdlp"]);
    expect(withoutRetiredIds(["lastfm", "ytdlp"])).toBeNull();
    expect(withoutRetiredIds(null)).toBeNull();
  });

  it("drops records keyed by a retired id", () => {
    expect(withoutRetiredKeys({ youtube: ["exec:yt-dlp"], ytdlp: ["exec:yt-dlp"] })).toEqual({ ytdlp: ["exec:yt-dlp"] });
    expect(withoutRetiredKeys({ ytdlp: "1.0.0" })).toBeNull();
    expect(withoutRetiredKeys(undefined)).toBeNull();
  });

  it("drops contribution switches by their owning plugin, not by a prefix match", () => {
    const saved = { "tidal-browse:menu:play": false, "youtube-extra:menu:x": false, "ytdlp:search:yt": false };
    expect(withoutRetiredContributions(saved)).toEqual({ "youtube-extra:menu:x": false, "ytdlp:search:yt": false });
    expect(withoutRetiredContributions({ "ytdlp:menu:watch": false })).toBeNull();
  });

  it("names the same ids as the backend", () => {
    const rust = readFileSync(join(__dirname, "../../src-tauri/src/plugins.rs"), "utf8");
    const m = /RETIRED_PLUGIN_IDS: &\[&str\] = &\[([^\]]*)\]/.exec(rust);
    expect(m).not.toBeNull();
    const ids = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(ids).toEqual([...RETIRED_PLUGIN_IDS]);
  });
});
