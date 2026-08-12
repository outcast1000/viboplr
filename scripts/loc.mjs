#!/usr/bin/env node

// Usage:
//   node scripts/loc.mjs                          report the working tree against the last saved entry
//   node scripts/loc.mjs --ref v1.0.21            report a git ref instead of the working tree
//   node scripts/loc.mjs save [--note "..."]      append the working tree to benchmarks/loc-history.json
//   node scripts/loc.mjs save --ref v1.0.21       append a past release (back-fills the series)
//
// `npm run bump` calls the same code path, so a release always records an entry;
// this CLI exists for checking the number between releases and for back-filling.

import { readFileSync } from "fs";
import { join } from "path";
import { locStep, REPO_ROOT, HISTORY_PATH } from "./lib/locRepo.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] ?? null;
};
const save = argv.includes("save");
const ref = flag("ref");
const note = flag("note") ?? "";

// A back-filled ref is labelled with its own tag name; the working tree is
// labelled with the version it currently declares.
const pkgVersion = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
const version = flag("version") ?? (ref?.replace(/^v/, "") || pkgVersion);

const { report } = locStep({ version, ref, countRef: ref, save, note });
console.log(report);
if (save) console.log(`\nAppended to ${HISTORY_PATH.replace(REPO_ROOT, ".")}`);
