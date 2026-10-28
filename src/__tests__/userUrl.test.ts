import { describe, expect, it } from "vitest";
import { userUrlHost } from "../utils/userUrl";

describe("userUrlHost", () => {
  it("assumes https:// when no scheme was typed", () => {
    expect(userUrlHost(" example.com/manifest.json ")).toBe("example.com");
    expect(userUrlHost("nas.local:4533")).toBe("nas.local:4533");
  });

  it("counts only a leading scheme", () => {
    expect(userUrlHost("example.com/m.json?src=https://cdn/x")).toBe("example.com");
    expect(userUrlHost("localhost:4533")).toBe("localhost:4533");
  });

  it("keeps an explicit scheme", () => {
    expect(userUrlHost("http://example.com/manifest.json")).toBe("example.com");
  });

  it("falls back to the raw string when it doesn't parse", () => {
    expect(userUrlHost("not a url")).toBe("not a url");
  });
});
