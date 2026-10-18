import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { AlbumCardArt } from "../components/AlbumCardArt";
import { ArtistCardArt } from "../components/ArtistCardArt";
import type { Album, Artist } from "../types";

/**
 * An album or artist with no image shows an icon, never a letter. The letter
 * drew "[" for Navidrome's `[Unknown Album]` and "(" for a title opening with
 * punctuation, which is what replaced it.
 */
afterEach(cleanup);

const album = (title: string) => ({ id: 1, title, artist_name: "Kyuss" }) as unknown as Album;
const artist = (name: string) => ({ id: 1, name }) as unknown as Artist;

describe("missing album / artist art", () => {
  it("draws the disc for an album with no image, whatever its title", () => {
    for (const title of ["[Unknown Album]", "(What's the Story) Morning Glory?", "Homogenic"]) {
      const { container } = render(<AlbumCardArt album={album(title)} imagePath={null} />);
      expect(container.querySelector("svg.entity-art-fallback")).not.toBeNull();
      expect(container.textContent).toBe("");
      cleanup();
    }
  });

  it("draws the person for an artist with no image", () => {
    const { container } = render(<ArtistCardArt artist={artist("[Unknown Artist]")} imagePath={null} />);
    expect(container.querySelector("svg.entity-art-fallback")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("still shows the image when there is one", () => {
    const { container } = render(<AlbumCardArt album={album("Homogenic")} imagePath="https://example.com/a.jpg" />);
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("svg.entity-art-fallback")).toBeNull();
  });
});
