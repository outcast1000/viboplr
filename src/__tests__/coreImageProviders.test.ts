import { describe, it, expect } from "vitest";
import {
  CORE_EMBEDDED_PROVIDER,
  CORE_FOLDER_PROVIDER,
  coreProviderSupports,
  imageProviderName,
  isCoreImageProvider,
} from "../utils/coreImageProviders";

describe("isCoreImageProvider", () => {
  it("recognizes the built-ins and nothing else", () => {
    expect(isCoreImageProvider(CORE_FOLDER_PROVIDER)).toBe(true);
    expect(isCoreImageProvider(CORE_EMBEDDED_PROVIDER)).toBe(true);
    expect(isCoreImageProvider("lastfm")).toBe(false);
    expect(isCoreImageProvider("google-image-search")).toBe(false);
  });
});

describe("imageProviderName", () => {
  it("names core providers, which have no manifest to look up", () => {
    const names = new Map([["lastfm", "Last.fm"]]);
    expect(imageProviderName(CORE_FOLDER_PROVIDER, names)).toBe("Folder image");
    expect(imageProviderName(CORE_EMBEDDED_PROVIDER, names)).toBe("Embedded artwork");
    expect(imageProviderName(CORE_FOLDER_PROVIDER, names, "long")).toBe(
      "Folder image (next to the tracks)",
    );
  });

  it("prefers the plugin's manifest name, falling back to its id", () => {
    const names = new Map([["lastfm", "Last.fm"]]);
    expect(imageProviderName("lastfm", names)).toBe("Last.fm");
    expect(imageProviderName("uninstalled", names)).toBe("uninstalled");
  });
});

describe("coreProviderSupports", () => {
  // The chain is one ordered list per entity, and the tag list carries the same
  // core rows — so without this gate the Retrieve modal would offer "Embedded
  // artwork" for a tag, whose only possible outcome is an error row.
  it("scopes each built-in to the entities it can actually answer for", () => {
    expect(coreProviderSupports(CORE_FOLDER_PROVIDER, "album")).toBe(true);
    expect(coreProviderSupports(CORE_FOLDER_PROVIDER, "artist")).toBe(true);
    expect(coreProviderSupports(CORE_FOLDER_PROVIDER, "tag")).toBe(false);

    // Embedded art comes out of an audio file, so it is album-only: an artist
    // has no one file to read and a tag has no files of its own at all.
    expect(coreProviderSupports(CORE_EMBEDDED_PROVIDER, "album")).toBe(true);
    expect(coreProviderSupports(CORE_EMBEDDED_PROVIDER, "artist")).toBe(false);
    expect(coreProviderSupports(CORE_EMBEDDED_PROVIDER, "tag")).toBe(false);
  });

  it("claims nothing for a plugin id", () => {
    expect(coreProviderSupports("lastfm", "album")).toBe(false);
  });
});
