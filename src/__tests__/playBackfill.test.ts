import { describe, it, expect } from "vitest";
import { dropPlayedHead } from "../hooks/usePlayActions";
import type { QueueTrack } from "../types";

function t(title: string, opts?: { path?: string | null; artist?: string | null; key?: string }): QueueTrack {
  return {
    key: opts?.key ?? `ext:${title}`,
    path: opts?.path === undefined ? `file:///${title}.mp3` : opts.path,
    title,
    artist_name: opts?.artist === undefined ? "A" : opts.artist,
    album_title: null,
    duration_secs: null,
    format: null,
    liked: 0,
  };
}

describe("dropPlayedHead", () => {
  it("drops the head when the resolved tail starts with it", () => {
    const head = [t("Seed")];
    const tail = [t("Seed"), t("Two"), t("Three")];
    expect(dropPlayedHead(head, tail).map(x => x.title)).toEqual(["Two", "Three"]);
  });

  it("keeps everything when the tail already excludes the head", () => {
    const head = [t("Seed")];
    const tail = [t("Two"), t("Three")];
    expect(dropPlayedHead(head, tail).map(x => x.title)).toEqual(["Two", "Three"]);
  });

  it("drops a multi-track head run", () => {
    const head = [t("One"), t("Two")];
    const tail = [t("One"), t("Two"), t("Three")];
    expect(dropPlayedHead(head, tail).map(x => x.title)).toEqual(["Three"]);
  });

  it("stops at the first mismatch (partial head overlap)", () => {
    const head = [t("One"), t("Two")];
    const tail = [t("One"), t("Other"), t("Two")];
    expect(dropPlayedHead(head, tail).map(x => x.title)).toEqual(["Other", "Two"]);
  });

  it("keeps a later repeat of the head — that's the source's own order", () => {
    const head = [t("Seed")];
    const tail = [t("Seed"), t("Two"), t("Seed")];
    expect(dropPlayedHead(head, tail).map(x => x.title)).toEqual(["Two", "Seed"]);
  });

  it("matches on path when both sides have one, ignoring metadata drift", () => {
    const head = [t("Seed", { path: "spotify://1" })];
    // Same path, different display title (the resolved list has richer metadata).
    const tail = [t("Seed (Remastered)", { path: "spotify://1" }), t("Two")];
    expect(dropPlayedHead(head, tail).map(x => x.title)).toEqual(["Two"]);
  });

  it("does not match different paths that share a title", () => {
    const head = [t("Seed", { path: "spotify://1" })];
    const tail = [t("Seed", { path: "spotify://2" }), t("Two")];
    expect(dropPlayedHead(head, tail).map(x => x.title)).toEqual(["Seed", "Two"]);
  });

  it("falls back to title + artist when a side has no path yet", () => {
    const head = [t("Seed", { path: null })];
    const tail = [t("Seed", { path: null }), t("Two")];
    expect(dropPlayedHead(head, tail).map(x => x.title)).toEqual(["Two"]);
  });

  it("treats a same-title different-artist track as a different song", () => {
    const head = [t("Seed", { path: null, artist: "A" })];
    const tail = [t("Seed", { path: null, artist: "B" })];
    expect(dropPlayedHead(head, tail).map(x => x.artist_name)).toEqual(["B"]);
  });

  it("ignores keys — the resolved tail always carries fresh ones", () => {
    const head = [t("Seed", { key: "ext:1" })];
    const tail = [t("Seed", { key: "ext:99" }), t("Two")];
    expect(dropPlayedHead(head, tail).map(x => x.title)).toEqual(["Two"]);
  });

  it("returns an empty list when the tail is exactly the head", () => {
    const head = [t("Seed")];
    expect(dropPlayedHead(head, [t("Seed")])).toEqual([]);
  });

  it("handles an empty tail and an empty head", () => {
    expect(dropPlayedHead([t("Seed")], [])).toEqual([]);
    const tail = [t("One")];
    expect(dropPlayedHead([], tail)).toEqual(tail);
  });
});
