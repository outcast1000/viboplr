import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The persona pages (docs/for/*.html) are hand-written and never touched by
// bump.mjs, and any docs/** push to main deploys immediately — so a renamed
// screenshot or a home-grid card pointing at a page that doesn't exist would
// go live unnoticed. This pins every local href/src on the home page and the
// persona pages to a file that exists, and every help.html anchor to a real id.

const docs = resolve(__dirname, "../../docs");
const forDir = join(docs, "for");
const pages = ["index.html", ...readdirSync(forDir).filter((f) => f.endsWith(".html")).map((f) => `for/${f}`)];
const helpIds = new Set([...readFileSync(join(docs, "help.html"), "utf8").matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

function localRefs(html: string): string[] {
  return [...html.matchAll(/(?:href|src|poster)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:|mailto:|#)/.test(u));
}

describe("site persona pages", () => {
  it("links every persona page from the home grid, and nothing else", () => {
    const home = readFileSync(join(docs, "index.html"), "utf8");
    // Only the grid cards — other sections (e.g. the AI section's CTA) may link a persona page too.
    const linked = [...home.matchAll(/href="(for\/[^"]+\.html)" class="persona-card\b/g)].map((m) => m[1]).sort();
    expect(linked).toEqual(pages.filter((p) => p.startsWith("for/")).sort());
  });

  for (const page of pages) {
    it(`${page}: every local link and asset exists`, () => {
      const html = readFileSync(join(docs, page), "utf8");
      const missing: string[] = [];
      for (const ref of localRefs(html)) {
        const [path, anchor] = ref.split("#");
        const target = resolve(dirname(join(docs, page)), path);
        if (!existsSync(target)) missing.push(ref);
        else if (anchor && target === join(docs, "help.html") && !helpIds.has(anchor)) missing.push(ref);
      }
      expect(missing).toEqual([]);
    });
  }
});
