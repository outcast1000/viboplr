// Line-of-code counter — a dependency-free port of the VS Code Counter extension
// (uctakeoff.vscode-counter), which is what produced the historical snapshots in
// `.VSCodeCounter/` before this script existed.
//
// The port is deliberate rather than convenient: the extension has no CLI, and
// `npm run bump` must work on a machine with no VS Code installed. `countText`
// below is a line-for-line port of its `LineCounter.count`, and `LANGUAGES`
// freezes the language definitions it resolved on 2026-08-12 — including two
// quirks that look like bugs but are load-bearing for comparability:
//
//   * `.css` is reported as **PostCSS**, not CSS. Both languages claim `.css`
//     and the extension's last-writer-wins extension map happened to land on
//     PostCSS. Renaming it would silently break every delta against the old
//     snapshots.
//   * `.toml` is **not counted at all** (so `Cargo.toml` / `Cargo.lock` are
//     invisible). The TOML grammar registers filenames but no extensions.
//
// A file whose extension is in none of these tables is skipped, exactly as the
// extension's `ignoreUnsupportedFile` default does — `countFiles` returns those
// extensions so callers can report them instead of silently undercounting.

/** @typedef {{code: number, comment: number, blank: number}} Count */

// Frozen 2026-08-12 from the extension's merged language table (internal
// definitions + contributions from the installed VS Code extensions).
export const LANGUAGES = [
  {
    name: "TypeScript",
    extensions: [".ts", ".cts", ".mts"],
    lineComments: ["//"],
    blockComments: [["/*", "*/"]],
    blockStrings: [["`", "`"]],
    lineStrings: [["'", "'"], ['"', '"'], ["${", "}"]],
  },
  {
    name: "TypeScript JSX",
    extensions: [".tsx"],
    lineComments: ["//"],
    blockComments: [["{/*", "*/}"], ["/*", "*/"]],
    blockStrings: [["`", "`"]],
    lineStrings: [["'", "'"], ['"', '"'], ["${", "}"]],
  },
  {
    name: "JavaScript",
    extensions: [".js", ".mjs", ".cjs", ".es6", ".pac"],
    lineComments: ["//"],
    blockComments: [["/*", "*/"]],
    blockStrings: [["`", "`"]],
    lineStrings: [["'", "'"], ['"', '"'], ["${", "}"]],
  },
  {
    name: "JavaScript JSX",
    extensions: [".jsx"],
    lineComments: ["//"],
    blockComments: [["{/*", "*/}"], ["/*", "*/"]],
    blockStrings: [["`", "`"]],
    lineStrings: [["'", "'"], ['"', '"'], ["${", "}"]],
  },
  {
    name: "Rust",
    extensions: [".rs"],
    lineComments: ["//"],
    blockComments: [["/*", "*/"]],
    blockStrings: [],
    lineStrings: [['"', '"'], ["`", "`"], ["```", "```"]],
  },
  {
    // See header note: `.css` resolves to PostCSS, not CSS.
    name: "PostCSS",
    extensions: [".css", ".pcss", ".postcss"],
    lineComments: [],
    blockComments: [["/*", "*/"]],
    blockStrings: [],
    lineStrings: [['"', '"'], ["'", "'"]],
  },
  {
    name: "SCSS",
    extensions: [".scss"],
    lineComments: ["//"],
    blockComments: [["/*", "*/"]],
    blockStrings: [],
    lineStrings: [['"', '"'], ["'", "'"]],
  },
  {
    name: "HTML",
    extensions: [".html", ".htm", ".xhtml", ".ejs"],
    lineComments: [],
    blockComments: [["<!--", "-->"]],
    blockStrings: [],
    lineStrings: [["'", "'"], ['"', '"']],
  },
  {
    name: "XML",
    // No `.plist`: the extension's XML grammar does not claim it, so
    // src-tauri/Info.plist has never been counted. Adding it would step the
    // series by a file the old snapshots do not contain.
    extensions: [".xml", ".svg", ".xsd", ".xaml", ".rss"],
    lineComments: [],
    blockComments: [["<!--", "-->"]],
    blockStrings: [],
    lineStrings: [['"', '"'], ["'", "'"]],
  },
  {
    name: "JSON",
    extensions: [".json", ".webmanifest", ".geojson", ".jsonld", ".har"],
    lineComments: ["//"],
    blockComments: [["/*", "*/"]],
    blockStrings: [],
    lineStrings: [["'", "'"], ['"', '"'], ["`", "`"]],
  },
  {
    name: "JSON with Comments",
    extensions: [".jsonc", ".code-workspace", ".eslintrc", ".babelrc", ".hintrc"],
    filenames: ["tsconfig.json", "jsconfig.json", "settings.json", "launch.json", "tasks.json", "extensions.json", "keybindings.json", "mcp.json", "devcontainer.json"],
    lineComments: ["//"],
    blockComments: [["/*", "*/"]],
    blockStrings: [],
    lineStrings: [["'", "'"], ['"', '"'], ["`", "`"]],
  },
  {
    name: "Skill",
    filenames: ["skill.md"],
    lineComments: [],
    blockComments: [["<!--", "-->"]],
    blockStrings: [],
    lineStrings: [["<", ">"]],
  },
  {
    name: "Markdown",
    extensions: [".md", ".markdown", ".mkd", ".mdown"],
    lineComments: [],
    blockComments: [["<!--", "-->"]],
    blockStrings: [],
    lineStrings: [["<", ">"]],
  },
  {
    name: "YAML",
    extensions: [".yaml", ".yml"],
    lineComments: ["#"],
    blockComments: [],
    blockStrings: [],
    lineStrings: [['"', '"'], ["'", "'"], ["`", "`"]],
  },
  {
    name: "PowerShell",
    extensions: [".ps1", ".psm1", ".psd1"],
    lineComments: ["#"],
    blockComments: [["<#", "#>"]],
    blockStrings: [],
    lineStrings: [["@'", "\n'@"], ['@"', '\n"@'], ['"', '"'], ["'", "'"]],
  },
  {
    name: "Shell Script",
    extensions: [".sh", ".bash", ".zsh", ".fish"],
    lineComments: ["#"],
    blockComments: [],
    blockStrings: [],
    lineStrings: [['"', '"'], ["'", "'"], ["`", "`"]],
  },
  {
    name: "Properties",
    extensions: [".conf", ".properties", ".cfg", ".editorconfig", ".npmrc", ".gitattributes"],
    filenames: [".env"],
    lineComments: ["#"],
    blockComments: [["#", " "]],
    blockStrings: [],
    lineStrings: [['"', '"']],
  },
  {
    name: "Docker",
    extensions: [".dockerfile", ".containerfile"],
    filenames: ["dockerfile", "containerfile"],
    lineComments: ["#"],
    blockComments: [],
    blockStrings: [],
    lineStrings: [['"', '"'], ["'", "'"]],
  },
  {
    name: "Python",
    extensions: [".py", ".pyi", ".pyw"],
    lineComments: ["#"],
    blockComments: [['"""', '"""']],
    blockStrings: [['"""', '"""']],
    blockStringAsComment: true,
    lineStrings: [['"', '"'], ["'", "'"], ["`", "`"]],
  },
  {
    name: "SQL",
    extensions: [".sql"],
    lineComments: ["--"],
    blockComments: [["/*", "*/"]],
    blockStrings: [],
    lineStrings: [['"', '"'], ["'", "'"]],
  },
];

// Assets are expected to be uncounted, so listing them in the report's
// "not counted" line every run would bury the case that matters: a *source*
// file type silently going uncounted (a new .py, .go, .kt …).
export const BINARY_EXTENSIONS = new Set([
  ".png", ".webp", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".bmp", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".m4a", ".flac", ".wav",
  ".mp4", ".webm", ".mov", ".zip", ".gz", ".dmg", ".exe", ".dll", ".dylib", ".so",
]);

/* ------------------------------------------------------------------ engine */

const RX_ESCAPE = /[.*+?^${}()|[\]\\]/g;
const escapeForRegexp = (s) => s.replace(RX_ESCAPE, "\\$&");
const nextIndexOf = (str, search, from) => {
  const i = str.indexOf(search, from);
  return i >= 0 ? i + search.length : i;
};
const stringLiteralSource = ([start, end]) =>
  `${escapeForRegexp(start)}(?:\\\\.|[^${escapeForRegexp(end)}\\\\])*${escapeForRegexp(end)}`;

const CODE = 0, COMMENT = 1, BLANK = 2;
const compiled = new WeakMap();

function compile(lang) {
  let c = compiled.get(lang);
  if (c) return c;
  const blockComments = lang.blockComments ?? [];
  const blockStrings = lang.blockStrings ?? [];
  // A quote that also opens a block string or block comment must not be treated
  // as an inline string, or ``` in Rust would swallow the rest of the line.
  const lineStrings = (lang.lineStrings ?? []).filter(
    (p) => blockStrings.every((b) => !p[0].startsWith(b[0])) && blockComments.every((b) => !p[0].startsWith(b[0]))
  );
  const source = `(${[
    blockStrings.map((v) => escapeForRegexp(v[0])).join("|"),
    blockComments.map((v) => escapeForRegexp(v[0])).join("|"),
    lineStrings.map(stringLiteralSource).join("|"),
  ]
    .map((r) => (!r ? "(?!x)x" : r))
    .join(")|(")})`;
  c = { regex: new RegExp(source, "g"), blockComments, blockStrings, lineComments: lang.lineComments ?? [] };
  compiled.set(lang, c);
  return c;
}

/**
 * Classify every line of `text` as code, comment or blank.
 *
 * Port of VSCodeCounter's `LineCounter.count` with `includeIncompleteLine: true`
 * (its shipped default). That flag is why a file ending in a newline scores one
 * trailing blank line — the split leaves an empty final element and it is kept.
 *
 * @returns {Count}
 */
export function countText(text, lang) {
  const { regex, blockComments, blockStrings, lineComments } = compile(lang);
  const result = [0, 0, 0];
  let blockCommentEnd = "";
  let blockStringEnd = "";
  let type = BLANK;

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    let i = 0;
    if (blockCommentEnd.length > 0) type = COMMENT;
    else if (blockStringEnd.length <= 0) type = BLANK;

    while (i < line.length) {
      if (blockCommentEnd.length > 0) {
        const index = nextIndexOf(line, blockCommentEnd, i);
        if (index < 0) break;
        blockCommentEnd = "";
        i = index;
      } else if (blockStringEnd.length > 0) {
        const index = nextIndexOf(line, blockStringEnd, i);
        if (index < 0) break;
        blockStringEnd = "";
        i = index;
      } else if (lineComments.some((lc) => line.startsWith(lc))) {
        type = COMMENT;
        break;
      } else {
        regex.lastIndex = i;
        const match = regex.exec(line);
        if (!match) {
          type = CODE;
          break;
        }
        if (match[1]) {
          type = lang.blockStringAsComment && match.index === 0 ? COMMENT : CODE;
          blockStringEnd = blockStrings.find((v) => v[0] === match[1])?.[1] ?? "";
          i = match.index + match[1].length;
          continue;
        }
        if (match[2]) {
          type = match.index === 0 ? COMMENT : CODE;
          blockCommentEnd = blockComments.find((v) => v[0] === match[2])?.[1] ?? "";
          i = match.index + match[2].length;
          continue;
        }
        type = CODE;
        i += match[3]?.length ?? 1;
        break;
      }
    }
    result[type]++;
  }
  return { code: result[CODE], comment: result[COMMENT], blank: result[BLANK] };
}

const byFilename = new Map();
const byExtension = new Map();
for (const lang of LANGUAGES) {
  for (const f of lang.filenames ?? []) byFilename.set(f.toLowerCase(), lang);
  for (const e of lang.extensions ?? []) byExtension.set(e.toLowerCase(), lang);
}

/** Resolve a repo-relative path to a language, or null when unsupported. */
export function languageFor(filePath) {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
  const named = byFilename.get(base);
  if (named) return named;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return byExtension.get(base.slice(dot)) ?? null;
}

/**
 * Count a list of files.
 * @param {string[]} files repo-relative paths
 * @param {(path: string) => string | null} read returns file text, or null when unreadable
 * @returns {{files: Record<string, Count & {language: string}>, skipped: Record<string, number>}}
 */
export function countFiles(files, read) {
  /** @type {Record<string, Count & {language: string}>} */
  const counted = {};
  /** @type {Record<string, number>} */
  const skipped = {};
  for (const file of files) {
    const lang = languageFor(file);
    if (!lang) {
      const base = file.slice(file.lastIndexOf("/") + 1);
      const dot = base.lastIndexOf(".");
      const key = dot > 0 ? base.slice(dot) : base;
      skipped[key] = (skipped[key] ?? 0) + 1;
      continue;
    }
    const text = read(file);
    if (text === null) continue;
    counted[file] = { language: lang.name, ...countText(text, lang) };
  }
  return { files: counted, skipped };
}

/* --------------------------------------------------------------- reporting */

const zero = () => ({ files: 0, code: 0, comment: 0, blank: 0 });
const add = (acc, c) => {
  acc.files += 1;
  acc.code += c.code;
  acc.comment += c.comment;
  acc.blank += c.blank;
  return acc;
};

/**
 * Roll per-file counts up into the shape stored in benchmarks/loc-history.json.
 * Directories are top-level only; per-release entries stay small because the
 * bump report re-counts the previous release from git when it needs detail.
 */
export function summarize(counted) {
  const total = zero();
  /** @type {Record<string, ReturnType<typeof zero>>} */
  const languages = {};
  /** @type {Record<string, ReturnType<typeof zero>>} */
  const directories = {};
  for (const [file, c] of Object.entries(counted)) {
    add(total, c);
    add((languages[c.language] ??= zero()), c);
    const slash = file.indexOf("/");
    add((directories[slash === -1 ? "." : file.slice(0, slash)] ??= zero()), c);
  }
  return { total, languages, directories };
}

/** Roll per-file counts up by directory prefix, `depth` segments deep. */
export function byDirectory(counted, depth) {
  /** @type {Record<string, ReturnType<typeof zero>>} */
  const dirs = {};
  for (const [file, c] of Object.entries(counted)) {
    const parts = file.split("/");
    const key = parts.length === 1 ? "." : parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
    add((dirs[key] ??= zero()), c);
  }
  return dirs;
}

const n = (v) => v.toLocaleString("en-US");
const signed = (v) => (v > 0 ? "+" : v < 0 ? "" : "±") + n(v);
const pct = (delta, base) => (base === 0 ? "" : ` (${delta >= 0 ? "+" : ""}${((delta / base) * 100).toFixed(1)}%)`);

function deltaRows(prev, next, key = "code") {
  const names = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...names]
    .map((name) => ({
      name,
      now: next[name]?.[key] ?? 0,
      was: prev[name]?.[key] ?? 0,
      delta: (next[name]?.[key] ?? 0) - (prev[name]?.[key] ?? 0),
    }))
    .filter((r) => r.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/**
 * Human-readable delta report. `prevFiles` is optional: when the previous
 * release's tree could be re-counted from git, per-file movers are included.
 */
export function formatReport({ label, prev, next, prevFiles, nextFiles, skipped }) {
  const out = [];
  const t = next.total;
  const p = prev?.total ?? zero();
  out.push(`Code size — ${label}`);
  out.push("");
  if (!prev) {
    out.push(`  ${n(t.code)} code · ${n(t.comment)} comment · ${n(t.blank)} blank · ${n(t.files)} files`);
    out.push("  (no previous entry in benchmarks/loc-history.json — this is the baseline)");
  } else {
    const d = t.code - p.code;
    out.push(`  code     ${n(t.code).padStart(9)}   ${signed(d)}${pct(d, p.code)}`);
    out.push(`  comment  ${n(t.comment).padStart(9)}   ${signed(t.comment - p.comment)}`);
    out.push(`  blank    ${n(t.blank).padStart(9)}   ${signed(t.blank - p.blank)}`);
    out.push(`  files    ${n(t.files).padStart(9)}   ${signed(t.files - p.files)}`);

    const langs = deltaRows(prev.languages, next.languages);
    if (langs.length) {
      out.push("");
      out.push("  by language");
      for (const r of langs.slice(0, 8)) out.push(`    ${r.name.padEnd(20)} ${n(r.now).padStart(8)}   ${signed(r.delta)}`);
    }
    const dirs = deltaRows(prev.directories, next.directories);
    if (dirs.length) {
      out.push("");
      out.push("  by directory");
      for (const r of dirs.slice(0, 8)) out.push(`    ${r.name.padEnd(20)} ${n(r.now).padStart(8)}   ${signed(r.delta)}`);
    }
    if (prevFiles && nextFiles) {
      const movers = deltaRows(prevFiles, nextFiles).slice(0, 10);
      if (movers.length) {
        out.push("");
        out.push("  biggest movers");
        for (const r of movers) {
          const tag = r.was === 0 ? " (new)" : r.now === 0 ? " (gone)" : "";
          out.push(`    ${signed(r.delta).padStart(7)}  ${r.name}${tag}`);
        }
      }
    }
  }
  const unsupported = Object.entries(skipped ?? {})
    .filter(([ext]) => !BINARY_EXTENSIONS.has(ext.toLowerCase()))
    .sort((a, b) => b[1] - a[1]);
  if (unsupported.length) {
    out.push("");
    out.push(`  not counted: ${unsupported.slice(0, 8).map(([ext, count]) => `${ext} ×${count}`).join(", ")}`);
  }
  return out.join("\n");
}
