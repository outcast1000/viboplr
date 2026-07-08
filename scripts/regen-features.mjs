#!/usr/bin/env node

// Usage: node scripts/regen-features.mjs
//
// Regenerates docs/features.html from docs/features.json using the current
// package.json version — the same logic bump.mjs runs at release (Step 6).
// Run this after editing features.json so the two files don't drift.

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { renderFeaturesHtml } from "./lib/features.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const features = JSON.parse(readFileSync(resolve(root, "docs/features.json"), "utf8"));

writeFileSync(resolve(root, "docs/features.html"), renderFeaturesHtml(features, version));
console.log(`✓ docs/features.html regenerated (v${version})`);
