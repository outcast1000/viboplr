import { describe, it, expect } from "vitest";
import type { DependencyInfo } from "../hooks/useDependencies";
import {
  ONBOARDING_STEP_ORDER,
  visibleSteps,
  missingPluginDeps,
  stepsForDisplay,
  nextStepId,
  prevStepId,
  onboardingDecision,
} from "../components/onboardingSteps";

function dep(overrides: Partial<DependencyInfo> = {}): DependencyInfo {
  return {
    name: "yt-dlp",
    description: "Downloads audio/video",
    status: "notFound",
    internalConsumers: [],
    pluginConsumers: [],
    install: { macos: "brew install yt-dlp", windows: "winget install yt-dlp", linux: "apt install yt-dlp", url: "https://example.com" },
    managedAvailable: true,
    ...overrides,
  };
}

const consumer = { name: "YouTube", reason: "stream", required: true };

describe("visibleSteps", () => {
  it("shows all steps when deps are missing and lastfm is installed", () => {
    expect(visibleSteps({ missingDepNames: ["yt-dlp"], lastfmInstalled: true })).toEqual([
      ...ONBOARDING_STEP_ORDER,
    ]);
  });

  it("hides the dependencies step when nothing is missing", () => {
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: true });
    expect(steps).not.toContain("dependencies");
    expect(steps).toContain("lastfm");
  });

  it("hides the lastfm step when the plugin is not installed", () => {
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: false });
    expect(steps).toEqual(["welcome", "music", "plugins", "playback", "finish"]);
  });
});

describe("missingPluginDeps", () => {
  it("returns deps that are missing and plugin-consumed", () => {
    const deps = [
      dep({ name: "yt-dlp", status: "notFound", pluginConsumers: [consumer] }),
      dep({ name: "ffmpeg", status: "installed", pluginConsumers: [consumer] }),
      dep({ name: "other", status: "notFound", pluginConsumers: [] }),
    ];
    expect(missingPluginDeps(deps)).toEqual(["yt-dlp"]);
  });

  it("treats error status as missing", () => {
    const deps = [dep({ status: "error", pluginConsumers: [consumer] })];
    expect(missingPluginDeps(deps)).toEqual(["yt-dlp"]);
  });
});

describe("stepsForDisplay", () => {
  it("returns the visible steps when the current step is among them", () => {
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: false });
    expect(stepsForDisplay(steps, "music")).toEqual(steps);
  });

  it("keeps a now-invisible current step at its canonical position", () => {
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: true });
    expect(stepsForDisplay(steps, "dependencies")).toEqual([
      "welcome",
      "music",
      "plugins",
      "dependencies",
      "lastfm",
      "playback",
      "finish",
    ]);
  });
});

describe("nextStepId / prevStepId", () => {
  const all = visibleSteps({ missingDepNames: ["yt-dlp"], lastfmInstalled: true });

  it("advances through consecutive steps", () => {
    expect(nextStepId("welcome", all)).toBe("music");
    expect(prevStepId("music", all)).toBe("welcome");
  });

  it("skips invisible steps", () => {
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: false });
    expect(nextStepId("plugins", steps)).toBe("playback");
    expect(prevStepId("playback", steps)).toBe("plugins");
  });

  it("returns null at the ends", () => {
    expect(nextStepId("finish", all)).toBeNull();
    expect(prevStepId("welcome", all)).toBeNull();
  });

  it("is robust when the current step is no longer visible", () => {
    // e.g. the dependency finished installing while the user was on the step
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: true });
    expect(nextStepId("dependencies", steps)).toBe("lastfm");
    expect(prevStepId("dependencies", steps)).toBe("plugins");
  });
});

describe("onboardingDecision", () => {
  it("does nothing when onboarding is already complete", () => {
    expect(
      onboardingDecision({ onboardingComplete: true, pluginRecommendationsShown: false, collectionCount: 0 }),
    ).toBe("none");
  });

  it("marks existing profiles complete silently (legacy flag)", () => {
    expect(
      onboardingDecision({ onboardingComplete: false, pluginRecommendationsShown: true, collectionCount: 0 }),
    ).toBe("mark-complete");
  });

  it("marks existing profiles complete silently (collections present)", () => {
    expect(
      onboardingDecision({ onboardingComplete: false, pluginRecommendationsShown: false, collectionCount: 2 }),
    ).toBe("mark-complete");
  });

  it("shows the wizard for fresh profiles", () => {
    expect(
      onboardingDecision({ onboardingComplete: false, pluginRecommendationsShown: false, collectionCount: 0 }),
    ).toBe("show");
  });
});
