import { describe, it, expect } from "vitest";
import { parseMarkdown, parseInline } from "../utils/miniMarkdown";

describe("parseInline", () => {
  it("parses code, bold, italic and links", () => {
    expect(parseInline("a `b` **c** *d* [e](https://x.org)")).toEqual([
      { kind: "text", text: "a " },
      { kind: "code", text: "b" },
      { kind: "text", text: " " },
      { kind: "strong", children: [{ kind: "text", text: "c" }] },
      { kind: "text", text: " " },
      { kind: "em", children: [{ kind: "text", text: "d" }] },
      { kind: "text", text: " " },
      { kind: "link", href: "https://x.org", children: [{ kind: "text", text: "e" }] },
    ]);
  });

  it("refuses non-http links, keeping the text", () => {
    // A model that read a hostile page must not hand the user a javascript: link.
    const out = parseInline("[click](javascript:alert(1))");
    expect(out.some((n) => n.kind === "link")).toBe(false);
    expect(out.map((n) => (n.kind === "text" ? n.text : "")).join("")).toContain("click");
  });

  it("leaves snake_case names and lone asterisks alone", () => {
    expect(parseInline("call search_library_tracks now")).toEqual([{ kind: "text", text: "call search_library_tracks now" }]);
    expect(parseInline("5 * 3 = 15")).toEqual([{ kind: "text", text: "5 * 3 = 15" }]);
  });

  it("never yields markup as anything but text", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([{ kind: "text", text: "<img src=x onerror=alert(1)>" }]);
  });
});

describe("parseMarkdown", () => {
  it("splits paragraphs, headings, lists, code and rules", () => {
    const blocks = parseMarkdown("## Title\n\nOne\ntwo\n\n- a\n- b\n\n1. x\n2. y\n\n```js\nlet a = 1;\n```\n\n---");
    expect(blocks.map((b) => b.kind)).toEqual(["h", "p", "ul", "ol", "code", "hr"]);
    expect(blocks[0]).toMatchObject({ kind: "h", level: 2 });
    expect(blocks[4]).toEqual({ kind: "code", lang: "js", text: "let a = 1;" });
  });

  it("keeps a numbered list's start", () => {
    expect(parseMarkdown("3. c\n4. d")[0]).toMatchObject({ kind: "ol", start: 3 });
  });

  it("starts a list right after a paragraph line", () => {
    expect(parseMarkdown("Here you go:\n- one\n- two").map((b) => b.kind)).toEqual(["p", "ul"]);
  });

  it("parses a pipe table", () => {
    const [t] = parseMarkdown("| Song | Plays |\n|---|---:|\n| A | 3 |\n| B | 1 |");
    expect(t.kind).toBe("table");
    if (t.kind !== "table") return;
    expect(t.header).toHaveLength(2);
    expect(t.rows).toHaveLength(2);
  });

  it("runs an unclosed fence to the end", () => {
    expect(parseMarkdown("```\nstill code")).toEqual([{ kind: "code", lang: "", text: "still code" }]);
  });
});
