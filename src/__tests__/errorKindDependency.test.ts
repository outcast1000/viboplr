import { describe, expect, it } from "vitest";
import { classifyErrorKind, setDependencyNames } from "../utils/errorKind";

describe("dependency error bucket", () => {
  it("knows the core's tools without being told", () => {
    expect(classifyErrorKind("ffmpeg exited with code 1")).toBe("dependency");
    expect(classifyErrorKind("ffprobe: no such file")).toBe("dependency");
  });

  it("learns the tools plugins define, and forgets them when they go", () => {
    expect(classifyErrorKind("yt-dlp: command failed")).not.toBe("dependency");
    setDependencyNames(["ffmpeg", "yt-dlp", "rqbit"]);
    expect(classifyErrorKind("yt-dlp: command failed")).toBe("dependency");
    expect(classifyErrorKind("spawn rqbit ENOENT")).toBe("dependency");
    // A name inside a longer word is not that tool.
    expect(classifyErrorKind("rqbit-gui crashed")).not.toBe("dependency");
    setDependencyNames(["ffmpeg"]);
    expect(classifyErrorKind("yt-dlp: command failed")).not.toBe("dependency");
  });

  it("treats a tool name as text, not as a pattern", () => {
    setDependencyNames(["a.c"]);
    expect(classifyErrorKind("abc failed")).not.toBe("dependency");
    expect(classifyErrorKind("a.c failed")).toBe("dependency");
    setDependencyNames([]);
  });
});
