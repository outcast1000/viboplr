import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs dev script, no type declarations
import { classifyBuild, extractSample, ourCoalitions, parsePlistStream } from "../../scripts/perf-probe.mjs";

// `parsePlistStream` shells out to `plutil`, which exists only on macOS, and it
// deliberately swallows a conversion failure (a schema change must not abort a
// 60s capture). On CI's ubuntu-latest that swallowing turns the whole fixture
// into zero samples, so driving these tests through the parser made every
// assertion read empty data and fail. The JSON below is therefore the source of
// truth for the schema tests — they are pure and run everywhere — and the one
// test that genuinely needs plutil is gated on having it.
const HAS_PLUTIL = !spawnSync("plutil", ["-help"]).error;

// Fixture values are copied from a real `powermetrics -s tasks --show-process-coalition
// --show-process-gpu --show-process-energy --format plist` capture on macOS 25.5, so this
// exercises the quirks that actually broke the parser:
//   - a <date> node, which makes plutil reject the whole doc for JSON
//   - NUL-separated samples
//   - `all_tasks` as a system-wide SUMMARY dict, not a per-task array
//   - coalitions keyed by `id` (not `pid`), with gputime only at coalition level
//   - member tasks that carry no gputime_* keys at all
const VIBO_TASKS = [
  { pid: 54701, name: "com.apple.WebKit.WebContent", cpu: 47.23 },
  { pid: 54696, name: "viboplr", cpu: 38.27 },
  { pid: 54699, name: "com.apple.WebKit.GPU", cpu: 24.74 },
  { pid: 54700, name: "com.apple.WebKit.Networking", cpu: 1.34 },
];
const VSCODE_TASK = { pid: 111, name: "Code Helper (Renderer)", cpu: 589.41 };
const WS_TASK = { pid: 222, name: "WindowServer", cpu: 88.4 };

type Task = { pid: number; name: string; cpu: number };

function taskObj(t: Task) {
  return {
    name: t.name,
    pid: t.pid,
    cputime_ms_per_s: t.cpu,
    cputime_ns: Math.round(t.cpu * 1e6),
    energy_impact: t.cpu / 4,
  };
}

function taskXml(t: Task) {
  return `<dict><key>name</key><string>${t.name}</string><key>pid</key><integer>${t.pid}</integer>` +
    `<key>cputime_ms_per_s</key><real>${t.cpu}</real><key>cputime_ns</key><integer>${Math.round(t.cpu * 1e6)}</integer>` +
    `<key>energy_impact</key><real>${t.cpu / 4}</real></dict>`;
}

type SampleSpec = { cpu: number; gpu: number | null; energy: number };

// gpu: null reproduces powermetrics omitting gputime_* entirely for a coalition that
// did no GPU work — observed on 133 of 136 coalitions in a real capture.
function sampleObj({ cpu, gpu, energy }: SampleSpec) {
  return {
    is_delta: true,
    elapsed_ns: 1048588416,
    // The parser demotes the <date> node to a string on the way in, so what
    // comes back out is a plain string.
    timestamp: "2026-08-11T10:21:58Z",
    all_tasks: { name: "all_tasks", cputime_ms_per_s: 2179.18 },
    coalitions: [
      {
        name: "com.microsoft.VSCode",
        id: 12345,
        cputime_ms_per_s: 977.61,
        gputime_ms_per_s: 10.3,
        energy_impact: 1400,
        tasks: [taskObj(VSCODE_TASK)],
      },
      {
        name: "com.apple.WindowServer",
        id: 222,
        cputime_ms_per_s: 88.4,
        gputime_ms_per_s: 20.9597,
        energy_impact: 60,
        tasks: [taskObj(WS_TASK)],
      },
      {
        name: "com.alex.viboplr",
        id: 56774,
        cputime_ms_per_s: cpu,
        ...(gpu === null ? {} : { gputime_ms_per_s: gpu, gputime_ns: Math.round(gpu * 1e6) }),
        energy_impact: energy,
        tasks: VIBO_TASKS.map(taskObj),
      },
    ],
  };
}

function sampleXml({ cpu, gpu, energy }: SampleSpec) {
  const gpuKeys =
    gpu === null
      ? ""
      : `<key>gputime_ms_per_s</key><real>${gpu}</real><key>gputime_ns</key><integer>${Math.round(gpu * 1e6)}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>is_delta</key><true/>
<key>elapsed_ns</key><integer>1048588416</integer>
<key>timestamp</key><date>2026-08-11T10:21:58Z</date>
<key>all_tasks</key><dict><key>name</key><string>all_tasks</string><key>cputime_ms_per_s</key><real>2179.18</real></dict>
<key>coalitions</key><array>
  <dict>
    <key>name</key><string>com.microsoft.VSCode</string>
    <key>id</key><integer>12345</integer>
    <key>cputime_ms_per_s</key><real>977.61</real>
    <key>gputime_ms_per_s</key><real>10.30</real>
    <key>energy_impact</key><real>1400.0</real>
    <key>tasks</key><array>${taskXml(VSCODE_TASK)}</array>
  </dict>
  <dict>
    <key>name</key><string>com.apple.WindowServer</string>
    <key>id</key><integer>222</integer>
    <key>cputime_ms_per_s</key><real>88.4</real>
    <key>gputime_ms_per_s</key><real>20.9597</real>
    <key>energy_impact</key><real>60.0</real>
    <key>tasks</key><array>${taskXml(WS_TASK)}</array>
  </dict>
  <dict>
    <key>name</key><string>com.alex.viboplr</string>
    <key>id</key><integer>56774</integer>
    <key>cputime_ms_per_s</key><real>${cpu}</real>
    ${gpuKeys}
    <key>energy_impact</key><real>${energy}</real>
    <key>tasks</key><array>${VIBO_TASKS.map(taskXml).join("")}</array>
  </dict>
</array>
</dict>
</plist>`;
}

function writeStream(samples: SampleSpec[]) {
  const dir = mkdtempSync(join(tmpdir(), "perfprobe-test-"));
  const path = join(dir, "pm.plist");
  // powermetrics NUL-separates consecutive plists.
  writeFileSync(path, samples.map(sampleXml).join("\0"));
  return { path, dir };
}

const SAMPLES: SampleSpec[] = [
  { cpu: 124.56, gpu: 0.81, energy: 34.69 },
  { cpu: 109.4, gpu: 0.97, energy: 32.38 },
  // Real capture: the app's coalition carried no gputime_* keys at all this interval.
  { cpu: 108.183, gpu: null, energy: 30.0 },
];

const PARSED = SAMPLES.map(sampleObj);

describe("perf-probe build classification", () => {
  // Tauri names the bundle executable after the Cargo package (`name = "viboplr"`),
  // NOT productName ("Viboplr"). So the release app's process is lowercase `viboplr`,
  // identical to the dev binary — the name is worthless as a discriminator and only
  // the path works. Verified: CFBundleExecutable of the installed 1.0.20 app is
  // literally "viboplr".
  it("identifies the installed release bundle", () => {
    expect(classifyBuild("/Applications/Viboplr.app/Contents/MacOS/viboplr")).toBe("release");
  });

  it("identifies a cargo build directory", () => {
    expect(classifyBuild("/Users/alex/Code/viboplr/src-tauri/target/debug/viboplr")).toBe("dev");
    expect(classifyBuild("/Users/alex/Code/viboplr/src-tauri/target/release/viboplr")).toBe("dev");
  });

  it("does not guess from a bare process name", () => {
    expect(classifyBuild("viboplr")).toBe("unknown");
    expect(classifyBuild("")).toBe("unknown");
  });

  it("classifies a bundle built into the target dir as dev, not release", () => {
    // `tauri build` leaves a .app under target/. It is a release compile but not the
    // installed artifact, and target/ wins so the run is flagged rather than trusted.
    expect(
      classifyBuild("/Users/alex/Code/viboplr/src-tauri/target/release/bundle/macos/Viboplr.app/Contents/MacOS/viboplr"),
    ).toBe("dev");
  });
});

// The only test that needs the macOS toolchain. It also pins the fixture the rest
// of the file asserts against: if plutil's output ever stops looking like PARSED,
// the schema tests below are testing fiction, and this is what says so.
describe.runIf(HAS_PLUTIL)("perf-probe plist conversion (needs macOS plutil)", () => {
  it("splits NUL-separated samples, survives the <date> node, and yields the fixture", () => {
    // JSON has no date type; without demoting <date> to <string>, plutil rejects
    // the entire document and every metric silently reads zero.
    const { path, dir } = writeStream(SAMPLES);
    const parsed = parsePlistStream(path, dir);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].elapsed_ns).toBe(1048588416);
    expect(parsed).toEqual(PARSED);
  });
});

describe("perf-probe powermetrics parsing", () => {
  it("identifies the coalition from the app pid alone", () => {
    const mine = ourCoalitions(PARSED[1], new Set([54696]));
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe("com.alex.viboplr");
  });

  it("picks up the launchd-parented WebKit helpers via coalition membership", () => {
    const mine = ourCoalitions(PARSED[1], new Set([54696]));
    const names = (mine[0].tasks as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("com.apple.WebKit.WebContent");
    expect(names).toContain("com.apple.WebKit.GPU");
    expect(names).toContain("com.apple.WebKit.Networking");
  });

  it("reports the coalition aggregate for cpu and gpu", () => {
    const ex = extractSample(PARSED[1], new Set([54696]));
    expect(ex.cpu).toBeCloseTo(109.4, 2);
    // GPU exists only on the coalition — member tasks have no gputime_* keys.
    expect(ex.gpu).toBeCloseTo(0.97, 2);
    expect(ex.source).toBe("coalition");
  });

  it("never counts all_tasks as one of ours", () => {
    // all_tasks is a system-wide summary (2179 ms/s here). Counting it would report
    // the whole machine's load as the app's.
    const ex = extractSample(PARSED[1], new Set([54696]));
    expect(Object.keys(ex.perProcess)).not.toContain("all_tasks");
    expect(ex.cpu).toBeLessThan(200);
  });

  it("does not attribute an unrelated coalition", () => {
    const ex = extractSample(PARSED[1], new Set([54696]));
    expect(Object.keys(ex.perProcess)).toHaveLength(4);
    expect(Object.keys(ex.perProcess)).not.toContain("Code Helper (Renderer)");
  });

  it("excludes a second same-named instance when pids are known", () => {
    // A forgotten `tauri dev` alongside the release build must not double the totals,
    // which is why pid membership wins over the name match.
    const twoInstances = {
      ...PARSED[1],
      coalitions: [
        ...PARSED[1].coalitions,
        {
          name: "com.alex.viboplr",
          id: 99999,
          cputime_ms_per_s: 500,
          gputime_ms_per_s: 9,
          energy_impact: 100,
          tasks: [{ pid: 777777, name: "viboplr", cputime_ms_per_s: 500 }],
        },
      ],
    };
    expect(extractSample(twoInstances, new Set([54696])).cpu).toBeCloseTo(109.4, 2);
  });

  it("treats omitted gputime_* keys as zero, not as a crash or NaN", () => {
    const ex = extractSample(PARSED[2], new Set([54696]));
    expect(ex.gpu).toBe(0);
    expect(ex.cpu).toBeCloseTo(108.183, 2);
  });

  it("reads WindowServer separately from the app's own coalition", () => {
    // Compositing is billed to WindowServer, so without this the transparent,
    // undecorated window's GPU cost would be invisible in every scenario.
    const ex = extractSample(PARSED[1], new Set([54696]));
    expect(ex.wsGpu).toBeCloseTo(20.9597, 3);
    expect(ex.wsCpu).toBeCloseTo(88.4, 2);
    // And it must not be folded into the app's own numbers.
    expect(ex.cpu).toBeCloseTo(109.4, 2);
    expect(Object.keys(ex.perProcess)).not.toContain("WindowServer");
  });

  it("still reports WindowServer when the app coalition is absent", () => {
    // The baseline scenario has no app coalition but its WindowServer reading is
    // what every other scenario's delta is measured against.
    const stripped = {
      ...PARSED[1],
      coalitions: PARSED[1].coalitions.filter((c: { name: string }) => !/viboplr/i.test(c.name)),
    };
    const ex = extractSample(stripped, new Set([999999]));
    expect(ex.source).toBe("absent");
    expect(ex.wsGpu).toBeCloseTo(20.9597, 3);
  });

  it("falls back to the name match when no pid is known", () => {
    const mine = ourCoalitions(PARSED[1], new Set([999999]));
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe("com.alex.viboplr");
  });

  it("reports absent rather than zero-with-confidence when the coalition is gone", () => {
    const stripped = {
      ...PARSED[1],
      coalitions: PARSED[1].coalitions.filter((c: { name: string }) => !/viboplr/i.test(c.name)),
    };
    const ex = extractSample(stripped, new Set([999999]));
    expect(ex.source).toBe("absent");
    expect(ex.cpu).toBe(0);
  });
});
