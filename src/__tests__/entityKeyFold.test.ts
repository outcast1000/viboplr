import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { entityKey, trackLikeKey } from "../likeKeys";
import { trackLikeId } from "../utils/likeReconcile";

// The fixture Rust's `test_entity_key_fold_matches_the_shared_fixture` pins
// `build_entity_key` against. Rust is the source of truth: if this fails, fix
// the TS fold, never the expected key.
interface FoldCase {
  kind: "track" | "album" | "artist" | "tag";
  name: string;
  artist: string | null;
  key: string;
}
const fixture = JSON.parse(
  readFileSync(join(__dirname, "../../src-tauri/tests/fixtures/entity-key-fold.json"), "utf8"),
) as { cases: FoldCase[] };

describe("entity key fold (shared with Rust)", () => {
  it("has cases", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixture.cases) {
    it(`${c.kind} ${JSON.stringify(c.name)} / ${JSON.stringify(c.artist)}`, () => {
      expect(entityKey(c.kind, c.name, c.artist)).toBe(c.key);
    });
  }

  it("trackLikeKey and trackLikeId are the track key", () => {
    for (const c of fixture.cases.filter((c) => c.kind === "track")) {
      expect(trackLikeKey(c.name, c.artist)).toBe(c.key);
      expect(trackLikeId(c.name, c.artist)).toBe(c.key);
    }
  });

  it("a padded title is the same song as the trimmed one", () => {
    expect(trackLikeId(" Song ", "Band ")).toBe(trackLikeId("Song", "Band"));
  });
});
