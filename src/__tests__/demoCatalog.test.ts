import { describe, expect, it } from "vitest";
import {
  ARTISTS,
  LYRICS,
  SHOWCASE,
  catalogTracks,
  historyPlan,
  historySql,
  likePlan,
  lrcText,
  synthExpression,
  // @ts-expect-error — plain .mjs dev script, no type declarations
} from "../../scripts/lib/demoCatalog.mjs";
// @ts-expect-error — plain .mjs dev script, no type declarations
import { encodePng, paint } from "../../scripts/lib/demoArt.mjs";

type T = { artist: string; album: string; title: string; durationSecs: number; dir: string; file: string; lyrics: unknown };
const tracks: T[] = catalogTracks();
const has = (artist: string, title: string) => tracks.some((t) => t.artist === artist && t.title === title);

describe("demo catalogue", () => {
  it("is ASCII, so canonical history names are just lowercase", () => {
    // historySql writes canonical names as `name.toLowerCase()`; the app
    // also strips diacritics, so a non-ASCII name would never match.
    for (const t of tracks) expect(/^[\x20-\x7e]+$/.test(`${t.artist}${t.album}${t.title}`)).toBe(true);
  });

  it("has unique files and a showcase that points at real tracks", () => {
    const paths = tracks.map((t) => `${t.dir}/${t.file}`);
    expect(new Set(paths).size).toBe(paths.length);
    expect(has(SHOWCASE.lyrics.artist, SHOWCASE.lyrics.title)).toBe(true);
    expect(has(SHOWCASE.radioSeed.artist, SHOWCASE.radioSeed.title)).toBe(true);
    expect(has(SHOWCASE.detailTrack.artist, SHOWCASE.detailTrack.title)).toBe(true);
    expect(tracks.some((t) => t.album === SHOWCASE.detailAlbum.title && t.artist === SHOWCASE.detailAlbum.artist)).toBe(true);
    expect(ARTISTS.some((a: { name: string }) => a.name === SHOWCASE.heroArtist)).toBe(true);
  });

  it("gives every lyric sheet a track long enough to hold it", () => {
    for (const l of LYRICS) {
      const t = tracks.find((x) => x.artist === l.artist && x.title === l.title);
      expect(t).toBeDefined();
      expect(t!.durationSecs).toBeGreaterThan(l.lines[l.lines.length - 1][0] + 15);
      expect(lrcText(l)).toMatch(/^\[ar:.*\]\n\[ti:.*\]\n\[00:\d\d\.00\]/);
    }
  });

  it("synthesises with ffmpeg-safe expressions (no quote breaks out of the filter)", () => {
    for (const t of tracks.slice(0, 20)) expect(synthExpression(t)).not.toMatch(/['";]/);
  });
});

describe("demo history and likes", () => {
  const now = 1_800_000_000;
  const plays = historyPlan(tracks, now);

  it("is deterministic and only names catalogue tracks", () => {
    expect(historyPlan(tracks, now)).toEqual(plays);
    for (const p of plays.slice(0, 200)) expect(has(p.artist, p.title)).toBe(true);
    expect(plays.every((p: { playedAt: number }) => p.playedAt <= now)).toBe(true);
  });

  it("leaves the forgotten favourites unplayed for months", () => {
    const recent = plays.filter((p: { album?: string; playedAt: number; title: string }) => p.playedAt > now - 150 * 86400);
    expect(recent.some((p: { title: string }) => p.title === "Velvet Hours")).toBe(false);
  });

  it("writes SQL that quotes every name", () => {
    const sql = historySql([{ artist: "O'Hara", title: "It's", playedAt: now }], [], now);
    expect(sql).toContain("'o''hara'");
    expect(sql).toContain("'It''s'");
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("likes only catalogue entities", () => {
    const likes = likePlan(tracks);
    expect(likes.tracks.length).toBeGreaterThan(10);
    for (const t of likes.tracks) expect(has(t.artistName, t.title)).toBe(true);
    for (const a of likes.albums) expect(tracks.some((t) => t.album === a.title && t.artist === a.artistName)).toBe(true);
  });
});

describe("demo art", () => {
  it("is deterministic per seed and encodes a valid PNG", () => {
    const a = paint("auto", "album|x", 32);
    expect(paint("auto", "album|x", 32).rgb.equals(a.rgb)).toBe(true);
    const png: Buffer = encodePng(a);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(32);
  });
});
