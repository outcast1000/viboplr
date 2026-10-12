import { describe, it, expect } from "vitest";
import { parseAppLink } from "../utils/appLinks";

describe("parseAppLink", () => {
  it("parses a play link", () => {
    expect(parseAppLink("viboplr://play?title=J%C3%B3ga&artist=Bj%C3%B6rk&album=Homogenic")).toEqual({
      verb: "play", title: "Jóga", artistName: "Björk", albumTitle: "Homogenic",
    });
  });

  it("treats the album as optional and accepts a trailing slash", () => {
    expect(parseAppLink("viboplr://play/?title=Song&artist=Band")).toEqual({
      verb: "play", title: "Song", artistName: "Band", albumTitle: null,
    });
  });

  it("decodes + as a space", () => {
    expect(parseAppLink("viboplr://play?title=Hey+Jude&artist=The+Beatles")).toMatchObject({
      title: "Hey Jude", artistName: "The Beatles",
    });
  });

  it("refuses a play link without both title and artist", () => {
    expect(parseAppLink("viboplr://play?title=Song")).toBeNull();
    expect(parseAppLink("viboplr://play?artist=Band")).toBeNull();
    expect(parseAppLink("viboplr://play?title=%20&artist=Band")).toBeNull();
    expect(parseAppLink("viboplr://play")).toBeNull();
  });

  it("parses open links for artists and albums", () => {
    expect(parseAppLink("viboplr://open?kind=artist&name=Portishead")).toEqual({
      verb: "open", kind: "artist", name: "Portishead",
    });
    expect(parseAppLink("viboplr://open?kind=album&name=Dummy&artist=Portishead")).toEqual({
      verb: "open", kind: "album", name: "Dummy", artistName: "Portishead",
    });
    expect(parseAppLink("viboplr://open?kind=album&name=Dummy")).toMatchObject({ artistName: null });
  });

  it("has no open link for a song, and no other verbs", () => {
    expect(parseAppLink("viboplr://open?kind=track&name=Song&artist=Band")).toBeNull();
    expect(parseAppLink("viboplr://open?kind=artist")).toBeNull();
    expect(parseAppLink("viboplr://enqueue?title=Song&artist=Band")).toBeNull();
    expect(parseAppLink("viboplr://player?title=Song&artist=Band")).toBeNull();
    expect(parseAppLink("viboplr://plugin/community/subject?id=1")).toBeNull();
  });

  it("refuses an implausibly long name", () => {
    expect(parseAppLink(`viboplr://play?title=${"a".repeat(501)}&artist=Band`)).toBeNull();
  });
});
