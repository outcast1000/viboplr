import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs dev script, no type declarations
import { countText, languageFor, summarize, byDirectory, formatReport, LANGUAGES } from "../../scripts/lib/loc.mjs";

// `scripts/lib/loc.mjs` is a port of the VS Code Counter extension's line
// classifier (see its header). The extension has no CLI, so these tests are the
// only automated guard that the port still classifies lines the way the
// historical snapshots in benchmarks/loc-history.json were produced. A change
// that moves any of these numbers is a series break, not a bug fix.

const lang = (name: string) => {
  const found = LANGUAGES.find((l: { name: string }) => l.name === name);
  if (!found) throw new Error(`no language named ${name}`);
  return found;
};

describe("countText", () => {
  it("classifies code, line comments and blanks", () => {
    const src = ["const a = 1;", "// a comment", "", "  ", "const b = 2; // trailing"].join("\n");
    // A whitespace-only line is blank (every line is trimmed first), and a line
    // with code before its `//` counts as code, not comment.
    expect(countText(src, lang("TypeScript"))).toEqual({ code: 2, comment: 1, blank: 2 });
  });

  it("counts the empty element after a final newline as a blank line", () => {
    // includeIncompleteLine: true is the extension's shipped default, and it is
    // why every file ending in \n scores one trailing blank.
    expect(countText("a\n", lang("TypeScript"))).toEqual({ code: 1, comment: 0, blank: 1 });
    expect(countText("a", lang("TypeScript"))).toEqual({ code: 1, comment: 0, blank: 0 });
  });

  it("treats a block comment as comment only when it opens the line", () => {
    const opens = ["/* hello", " still comment", "*/"].join("\n");
    expect(countText(opens, lang("TypeScript"))).toEqual({ code: 0, comment: 3, blank: 0 });

    const trailing = ["const a = 1; /* hi", "inside", "*/ const b = 2;"].join("\n");
    expect(countText(trailing, lang("TypeScript"))).toEqual({ code: 2, comment: 1, blank: 0 });
  });

  it("does not treat comment markers inside strings as comments", () => {
    const src = ['const url = "https://example.com";', "const path = '// not a comment';"].join("\n");
    expect(countText(src, lang("TypeScript"))).toEqual({ code: 2, comment: 0, blank: 0 });
  });

  it("counts an empty line inside a template literal as code, not blank", () => {
    // Surprising but deliberate: while a block string is open the line type
    // carries over from the previous line instead of resetting to blank, so the
    // gap inside a multi-line template is code. Matching this is the whole
    // point of porting the classifier rather than writing a new one.
    const src = ["const t = `line", "", "end`;"].join("\n");
    expect(countText(src, lang("TypeScript"))).toEqual({ code: 3, comment: 0, blank: 0 });
  });

  it("understands JSX block comments in .tsx", () => {
    const src = ["{/* a jsx comment */}", "<div />"].join("\n");
    expect(countText(src, lang("TypeScript JSX"))).toEqual({ code: 1, comment: 1, blank: 0 });
  });

  it("counts Rust doc comments as comments", () => {
    const src = ["/// docs", "//! inner docs", "pub fn f() {}"].join("\n");
    expect(countText(src, lang("Rust"))).toEqual({ code: 1, comment: 2, blank: 0 });
  });

  it("has no line comment syntax in CSS", () => {
    // `//` is not a CSS comment — it is code, which is why the PostCSS numbers
    // differ from what a naive counter would report.
    const src = ["/* real comment */", "// not a comment", ".a { color: red; }"].join("\n");
    expect(countText(src, lang("PostCSS"))).toEqual({ code: 2, comment: 1, blank: 0 });
  });

  it("counts YAML and HTML comments", () => {
    expect(countText("# c\nkey: value", lang("YAML"))).toEqual({ code: 1, comment: 1, blank: 0 });
    expect(countText("<!-- c -->\n<p>hi</p>", lang("HTML"))).toEqual({ code: 1, comment: 1, blank: 0 });
  });
});

describe("languageFor", () => {
  it("maps the extensions this repo actually contains", () => {
    expect(languageFor("src/App.tsx").name).toBe("TypeScript JSX");
    expect(languageFor("src/utils.ts").name).toBe("TypeScript");
    expect(languageFor("scripts/bump.mjs").name).toBe("JavaScript");
    expect(languageFor("src-tauri/src/lib.rs").name).toBe("Rust");
    expect(languageFor("src/App.css").name).toBe("PostCSS");
    expect(languageFor("docs/index.html").name).toBe("HTML");
    expect(languageFor("README.md").name).toBe("Markdown");
    expect(languageFor("public/icon.svg").name).toBe("XML");
  });

  it("prefers a filename rule over the extension", () => {
    expect(languageFor("package.json").name).toBe("JSON");
    expect(languageFor("tsconfig.json").name).toBe("JSON with Comments");
    expect(languageFor(".claude/skills/release/SKILL.md").name).toBe("Skill");
    expect(languageFor("docs/README.md").name).toBe("Markdown");
  });

  it("returns null for the file types the extension never counted", () => {
    // Deliberate: adding these would step the series against the old snapshots.
    expect(languageFor("src-tauri/Cargo.toml")).toBeNull();
    expect(languageFor("src-tauri/Cargo.lock")).toBeNull();
    expect(languageFor("src-tauri/Info.plist")).toBeNull();
    expect(languageFor("LICENSE")).toBeNull();
    expect(languageFor("docs/assets/shot.png")).toBeNull();
  });
});

describe("summarize", () => {
  const counted = {
    "src/App.tsx": { language: "TypeScript JSX", code: 10, comment: 2, blank: 1 },
    "src/hooks/useX.ts": { language: "TypeScript", code: 5, comment: 1, blank: 0 },
    "src/hooks/useY.ts": { language: "TypeScript", code: 7, comment: 0, blank: 3 },
    "README.md": { language: "Markdown", code: 4, comment: 0, blank: 2 },
  };

  it("rolls up totals, languages and top-level directories", () => {
    const s = summarize(counted);
    expect(s.total).toEqual({ files: 4, code: 26, comment: 3, blank: 6 });
    expect(s.languages.TypeScript).toEqual({ files: 2, code: 12, comment: 1, blank: 3 });
    expect(s.directories.src).toEqual({ files: 3, code: 22, comment: 3, blank: 4 });
    // Root-level files group under "." rather than vanishing.
    expect(s.directories["."]).toEqual({ files: 1, code: 4, comment: 0, blank: 2 });
  });

  it("groups deeper with byDirectory", () => {
    expect(byDirectory(counted, 2)["src/hooks"]).toEqual({ files: 2, code: 12, comment: 1, blank: 3 });
  });
});

describe("formatReport", () => {
  const prev = {
    version: "1.0.0",
    total: { files: 2, code: 100, comment: 10, blank: 5 },
    languages: { TypeScript: { files: 2, code: 100, comment: 10, blank: 5 } },
    directories: { src: { files: 2, code: 100, comment: 10, blank: 5 } },
  };
  const next = {
    total: { files: 3, code: 150, comment: 12, blank: 6 },
    languages: { TypeScript: { files: 3, code: 150, comment: 12, blank: 6 } },
    directories: { src: { files: 3, code: 150, comment: 12, blank: 6 } },
  };

  it("reports the delta against the previous entry", () => {
    const report = formatReport({ label: "1.0.0 → 1.0.1", prev, next, skipped: {} });
    expect(report).toContain("1.0.0 → 1.0.1");
    expect(report).toContain("+50 (+50.0%)");
    expect(report).toContain("TypeScript");
  });

  it("labels the first run as a baseline instead of diffing against nothing", () => {
    const report = formatReport({ label: "1.0.0", prev: null, next, skipped: {} });
    expect(report).toContain("baseline");
    expect(report).not.toContain("by language");
  });

  it("marks added and removed files in the movers list", () => {
    const report = formatReport({
      label: "1.0.0 → 1.0.1",
      prev,
      next,
      prevFiles: { "src/old.ts": { code: 40 } },
      nextFiles: { "src/new.ts": { code: 90 } },
      skipped: {},
    });
    expect(report).toContain("src/new.ts (new)");
    expect(report).toContain("src/old.ts (gone)");
  });

  it("hides binary assets from the not-counted line but keeps source types", () => {
    const report = formatReport({ label: "x", prev: null, next, skipped: { ".png": 17, ".toml": 1 } });
    expect(report).toContain(".toml ×1");
    expect(report).not.toContain(".png");
  });
});
