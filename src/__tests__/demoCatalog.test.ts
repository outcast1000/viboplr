import { describe, expect, it } from "vitest";
import {
  ARTISTS,
  LYRICS,
  SHOWCASE,
  canonicalName,
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

type T = { artist: string; album: string; title: string; durationSecs: number; dir: string; file: string; lyrics: unknown; art: boolean };
const tracks: T[] = catalogTracks();
const has = (artist: string, title: string) => tracks.some((t) => t.artist === artist && t.title === title);

describe("demo catalogue", () => {
  it("keys history the way the app does: lowercase, diacritics stripped", () => {
    // Mirrors strip_diacritics(to_lowercase()) — a mismatch and the plays of
    // "Haïti" would never reach its track.
    expect(canonicalName("Haïti")).toBe("haiti");
    expect(canonicalName("Une Année Sans Lumière")).toBe("une annee sans lumiere");
  });

  it("puts lyrics and folder art only on the invented album", () => {
    // Real songs' lyrics are copyrighted; real covers come from the app's
    // own image providers.
    for (const t of tracks) {
      if (t.lyrics) expect(t.artist).toBe(SHOWCASE.lyrics.artist);
      if (t.art) expect(t.artist).toBe(SHOWCASE.lyrics.artist);
    }
    expect(tracks.filter((t) => t.art).length).toBeGreaterThan(0);
  });

  it("has unique files and a showcase that points at real tracks", () => {
    const paths = tracks.map((t) => `${t.dir}/${t.file}`);
    expect(new Set(paths).size).toBe(paths.length);
    expect(has(SHOWCASE.lyrics.artist, SHOWCASE.lyrics.title)).toBe(true);
    expect(has(SHOWCASE.radioSeed.artist, SHOWCASE.radioSeed.title)).toBe(true);
    expect(has(SHOWCASE.detailTrack.artist, SHOWCASE.detailTrack.title)).toBe(true);
    expect(tracks.some((t) => t.album === SHOWCASE.detailAlbum.title && t.artist === SHOWCASE.detailAlbum.artist)).toBe(true);
    expect(ARTISTS).toContain(SHOWCASE.heroArtist);
    expect(has(SHOWCASE.lossless.artist, SHOWCASE.lossless.title)).toBe(true);
    for (const album of [SHOWCASE.obsession, ...SHOWCASE.forgotten]) expect(tracks.some((t) => t.album === album)).toBe(true);
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
    const forgotten = new Set(tracks.filter((t) => SHOWCASE.forgotten.includes(t.album)).map((t) => `${t.artist}|${t.title}`));
    const recent = plays.filter((p: { artist: string; title: string; playedAt: number }) => p.playedAt > now - 150 * 86400);
    expect(recent.some((p: { artist: string; title: string }) => forgotten.has(`${p.artist}|${p.title}`))).toBe(false);
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
