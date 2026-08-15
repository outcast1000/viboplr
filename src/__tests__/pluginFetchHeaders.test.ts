import { describe, expect, it } from "vitest";
import { foldHeaderPairs, setCookieValues } from "../utils/pluginFetchHeaders";

describe("foldHeaderPairs", () => {
  it("builds a case-insensitive lookup map", () => {
    expect(foldHeaderPairs([["Content-Type", "application/json"]])).toEqual({
      "content-type": "application/json",
    });
  });

  it("joins repeated headers rather than dropping them", () => {
    const folded = foldHeaderPairs([
      ["set-cookie", "SID=abc"],
      ["set-cookie", "theme=dark"],
    ]);
    expect(folded["set-cookie"]).toBe("SID=abc, theme=dark");
  });

  it("is empty for a response with no headers", () => {
    expect(foldHeaderPairs([])).toEqual({});
  });
});

describe("setCookieValues", () => {
  it("keeps every Set-Cookie intact and in order", () => {
    // The whole reason the backend sends pairs: a session API can set several
    // cookies at once, and the folded map's ", " join can't be split back apart
    // (a cookie's Expires attribute contains a comma of its own).
    const pairs: Array<[string, string]> = [
      ["set-cookie", "SID=abc; path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT"],
      ["content-type", "text/plain"],
      ["set-cookie", "theme=dark"],
    ];
    expect(setCookieValues(pairs)).toEqual([
      "SID=abc; path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
      "theme=dark",
    ]);
  });

  it("returns nothing when the response set no cookies", () => {
    expect(setCookieValues([["content-type", "text/plain"]])).toEqual([]);
  });
});
