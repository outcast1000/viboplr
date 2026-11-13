import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The site's pages are hand-written (features.html is generated, but from a
// hand-written template), and any docs/** push to main deploys immediately —
// so a renamed screenshot or a link to a page or section that doesn't exist
// would go live unnoticed. This pins every local href/src/poster on every page
// to a file that exists, and every #anchor into a page to a real id there.
// history.html is left out: it is the changelog, written by bump.mjs, and its
// links are release assets on GitHub.

const docs = resolve(__dirname, "../../docs");
const topLevel = readdirSync(docs).filter((f) => f.endsWith(".html") && f !== "history.html");
const nested = ["examples", "for"].flatMap((d) =>
  readdirSync(join(docs, d)).filter((f) => f.endsWith(".html")).map((f) => `${d}/${f}`),
);
const pages = [...topLevel, ...nested];

const idsCache = new Map<string, Set<string>>();
function idsOf(file: string): Set<string> {
  let ids = idsCache.get(file);
  if (!ids) {
    ids = new Set([...readFileSync(file, "utf8").matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    idsCache.set(file, ids);
  }
  return ids;
}

function localRefs(html: string): string[] {
  return [...html.matchAll(/(?:href|src|poster)="([^"]+)"|url=([^"]+)"/g)]
    .map((m) => m[1] ?? m[2])
    .filter((u) => !/^(https?:|mailto:|viboplr:)/.test(u));
}

describe("site links", () => {
  it("finds the pages", () => {
    expect(pages).toContain("index.html");
    expect(pages).toContain("for/audiophiles.html");
  });

  for (const page of pages) {
    it(`${page}: every local link, asset and anchor exists`, () => {
      const file = join(docs, page);
      const missing: string[] = [];
      for (const ref of localRefs(readFileSync(file, "utf8"))) {
        const [path, anchor] = ref.split("#");
        const target = path ? resolve(dirname(file), path) : file;
        if (!existsSync(target)) missing.push(ref);
        else if (anchor && target.endsWith(".html") && !idsOf(target).has(anchor)) missing.push(ref);
      }
      expect(missing).toEqual([]);
    });
  }

  // The old per-audience pages are kept as redirects for their inbound links.
  for (const page of nested.filter((p) => p.startsWith("for/"))) {
    it(`${page} redirects to the home page`, () => {
      const html = readFileSync(join(docs, page), "utf8");
      expect(html).toMatch(/<meta http-equiv="refresh" content="0; url=\.\.\/index\.html(#[a-z-]+)?">/);
    });
  }
});
