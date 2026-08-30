// Prepares the `perf` profile that `perf-probe --auto` and `app-smoke` drive.
//
// Four things have to be true before an unattended run means anything, and all
// four were silent failures before this existed:
//
//   1. Onboarding must be dismissed. A fresh profile shows the OnboardingWizard
//      over everything, so every scenario would have sampled the wizard.
//   2. A collection must exist, or there are no artists and `detail-hero` has
//      nothing to open.
//   3. Something must be queued. `play=on` against an empty queue is a no-op,
//      so every "playing" scenario would sample an idle app.
//   4. The hero effect must be pinned to a specific look. `resolveHeroLook`
//      reads a persisted mode: `disabled` renders no effect at all (so
//      `detail-hero` would report the animation stack as free) and `random`
//      picks a different look per run (so the series isn't comparable).
//
// 1-3 go through the app's own `viboplr://probe` verbs rather than editing its
// files: the app rewrites app-state.json from memory on a debounce, so anything
// written underneath it can be clobbered on the next flush, and the collection
// lives in the database where a file edit cannot reach at all. Only (4) is a
// plain store key with no command behind it, so it is still written directly —
// with the app stopped.
//
// Usage:
//   node scripts/setup-perf-profile.mjs --music /path/to/music
//   node scripts/setup-perf-profile.mjs --music <folder> --seed <audio-only folder>
//   node scripts/setup-perf-profile.mjs --music <folder> --look vhs
//   node scripts/setup-perf-profile.mjs --check     report readiness, change nothing

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  quitApp,
  launchApp,
  probeLink,
  probeDumpPath,
  waitFor,
  sleep,
  PROBE_PROFILE,
} from "./lib/appControl.mjs";

// Any specific look works as long as it renders overlay layers; `vhs` is the
// heaviest, which is the point of the detail-hero scenario. Keep in step with
// LOOKS in src/heroLooks.ts.
const DEFAULT_LOOK = "vhs";

const PROFILE_DIR = dirname(probeDumpPath(PROBE_PROFILE));
const STORE_PATH = join(PROFILE_DIR, "app-state.json");

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
    else flags[a.slice(2)] = argv[++i];
  }
  return flags;
}

function readStore() {
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Ask the running app to describe itself.
 *
 * Readiness is read from the *app*, not from its files. The queue in particular
 * is not a store key at all — it lives in main_playlist, behind the
 * `main_playlist_read` command — so a file-scraping check would have reported
 * "queue empty" forever.
 */
async function askApp() {
  const dumpPath = probeDumpPath(PROBE_PROFILE);
  rmSync(dumpPath, { force: true });
  await probeLink("dump=on");
  await waitFor(() => existsSync(dumpPath), 20000, "the app to answer with its state");
  return JSON.parse(readFileSync(dumpPath, "utf8"));
}

function report(dump, store) {
  const look = store.heroEffectMode;
  const lookOk = typeof look === "string" && look !== "random" && look !== "disabled";
  const artists = dump?.library?.artistNames ?? [];
  const rows = [
    ["app version", dump?.app?.version ?? "?"],
    ["profile", dump?.app?.profile ?? "?"],
    ["tracks", dump?.library?.trackCount ?? "?"],
    ["artists", artists.length ? artists.join(", ") : "NONE — detail-hero has nothing to open"],
    ["queue", dump?.library?.queueLength
      ? `${dump.library.queueLength} track(s)`
      : "EMPTY — every playing-* scenario would sample an idle app"],
    // Printed because it hid a whole invalidated run: the queue was seeded from
    // a folder containing one video, which sorted first, so every "playing
    // audio" scenario measured video decode. Now it is impossible not to notice.
    ["first track", dump?.ui?.currentTrack ?? "(nothing loaded)"],
    ["heroEffectMode", lookOk ? look : `${look ?? "unset"} — detail-hero needs a specific look`],
  ];
  for (const [k, v] of rows) console.log(`  ${String(k).padEnd(16)} ${v}`);
  if (artists.length) {
    console.log(`\n  Run the probe with:  npm run perf:probe -- run --auto --artist "${artists[0]}"`);
  }
}

async function main() {
  if (process.platform !== "darwin") {
    console.error("setup-perf-profile is macOS only.");
    process.exit(1);
  }
  const flags = parseArgs(process.argv.slice(2));

  if (flags.check) {
    await launchApp();
    const dump = await askApp();
    console.log(`\nperf profile: ${PROFILE_DIR}\n`);
    report(dump, readStore());
    await quitApp();
    return;
  }

  const music = typeof flags.music === "string" ? flags.music : null;
  if (!music) {
    console.error("Pass --music <folder> (a local music folder to add as a collection),");
    console.error("or --check to report readiness without changing anything.");
    process.exit(1);
  }
  if (!music.startsWith("/") || !existsSync(music)) {
    console.error(`--music must be an absolute path that exists: ${music}`);
    process.exit(1);
  }
  const look = typeof flags.look === "string" ? flags.look : DEFAULT_LOOK;
  // The queue seed is separate from the collection folder on purpose. The
  // collection wants breadth (artists for detail-hero); the queue wants audio
  // and nothing else. `openKind=audio` below covers this on a build that
  // supports it, but --seed also lets an older build be pointed at an
  // audio-only subtree.
  const seed = typeof flags.seed === "string" ? flags.seed : music;
  if (!seed.startsWith("/") || !existsSync(seed)) {
    console.error(`--seed must be an absolute path that exists: ${seed}`);
    process.exit(1);
  }

  // The look is the one setting with no command behind it, so it is written to
  // the store directly — which means the app must not be running, or its next
  // debounced flush would overwrite the file from memory.
  await quitApp();
  mkdirSync(PROFILE_DIR, { recursive: true });
  const store = readStore();
  store.heroEffectMode = look;
  writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
  console.log(`✓ hero look pinned to "${look}"`);

  await launchApp();
  // Onboarding first — the wizard sits over everything else.
  await probeLink("onboarding=dismiss");

  // Adding the same folder twice registers a SECOND collection over it, so every
  // track exists twice — the library went 60 -> 120 that way, silently changing
  // the baseline between runs. `add_collection` does not reject a duplicate
  // path, so the guard has to be here: a library that already has tracks is
  // already set up.
  let dump = await askApp();
  if (dump.library.trackCount) {
    console.log(`✓ onboarding dismissed; library already has ${dump.library.trackCount} tracks — not adding the collection again`);
  } else {
    await probeLink(`collection=${encodeURIComponent(music)}`);
    console.log("✓ onboarding dismissed, collection added — waiting for the scan");
    // Poll rather than sleeping a fixed amount: a big folder takes far longer.
    const deadline = Date.now() + 120000;
    while (!dump.library.trackCount && Date.now() < deadline) {
      await sleep(3000);
      dump = await askApp();
    }
    if (!dump.library.trackCount) {
      console.warn("  ! No tracks after 2 minutes — is that folder actually full of audio?");
    }
  }

  // Seed the queue from the same folder, through the resolver the Finder drop
  // path uses. Persisting it is what lets later runs just say `play=on`.
  //
  // `openKind=audio` is load-bearing: the resolver takes every supported media
  // type, so a single video in the folder sorts to the front and every
  // "playing audio" scenario silently measures video decode instead. That
  // invalidated a whole recorded run before this filter existed.
  await probeLink(`open=${encodeURIComponent(seed)}&openKind=audio`);
  await sleep(3000);
  dump = await askApp();

  // quitApp prefers the probe quit, which flushes the debounced store first —
  // without that the queue we just seeded might not survive.
  await quitApp();

  console.log(`\nperf profile: ${PROFILE_DIR}\n`);
  report(dump, readStore());
}

main().catch((e) => {
  console.error(`\n✖ ${e.message}`);
  process.exit(1);
});
