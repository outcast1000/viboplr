import { describe, it, expect } from "vitest";
import type { DependencyInfo } from "../hooks/useDependencies";
import {
  ONBOARDING_STEP_ORDER,
  visibleSteps,
  missingPluginDeps,
  autoInstallableDeps,
  spotifyConnection,
  stepsForDisplay,
  nextStepId,
  prevStepId,
  onboardingDecision,
  normalizeProfile,
  joinNames,
  ONBOARDING_PROFILES,
  PROFILE_PRESETS,
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
    declaredBy: [],
    signedDefinition: true,
    verified: true,
    sourceMismatch: false,
    ...overrides,
  };
}

const consumer = { name: "YouTube", reason: "stream", required: true };

describe("visibleSteps", () => {
  it("shows all steps when deps are missing and Spotify + Last.fm are there", () => {
    expect(
      visibleSteps({ missingDepNames: ["yt-dlp"], lastfmInstalled: true, spotifyActive: true, profile: "normal" }),
    ).toEqual([...ONBOARDING_STEP_ORDER]);
  });

  it("shows the Spotify step only while the plugin is running", () => {
    // Its sign-in is the plugin's own sync; an inactive plugin can't open it.
    expect(visibleSteps({ missingDepNames: [], lastfmInstalled: false, profile: "streaming" })).not.toContain("spotify");
    expect(
      visibleSteps({ missingDepNames: [], lastfmInstalled: false, spotifyActive: true, profile: "streaming" }),
    ).toContain("spotify");
  });

  it("hides the dependencies step when nothing is missing", () => {
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: true, profile: "normal" });
    expect(steps).not.toContain("dependencies");
    expect(steps).toContain("lastfm");
  });

  it("hides the lastfm step when the plugin is not installed", () => {
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: false, profile: "normal" });
    expect(steps).toEqual(["profile", "welcome", "music", "plugins", "playback"]);
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
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: false, profile: "normal" });
    expect(stepsForDisplay(steps, "music")).toEqual(steps);
  });

  it("keeps a now-invisible current step at its canonical position", () => {
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: true, profile: "normal" });
    expect(stepsForDisplay(steps, "dependencies")).toEqual([
      "profile",
      "welcome",
      "music",
      "plugins",
      "dependencies",
      "lastfm",
      "playback",
    ]);
  });
});

describe("nextStepId / prevStepId", () => {
  const all = visibleSteps({ missingDepNames: ["yt-dlp"], lastfmInstalled: true, profile: "normal" });

  it("advances through consecutive steps", () => {
    expect(nextStepId("welcome", all)).toBe("music");
    expect(prevStepId("music", all)).toBe("welcome");
  });

  it("skips invisible steps", () => {
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: false, profile: "normal" });
    expect(nextStepId("plugins", steps)).toBe("playback");
    expect(prevStepId("playback", steps)).toBe("plugins");
  });

  it("traverses the profile step at the start", () => {
    expect(nextStepId("profile", all)).toBe("welcome");
    expect(prevStepId("welcome", all)).toBe("profile");
  });

  it("returns null at the ends", () => {
    expect(nextStepId("playback", all)).toBeNull();
    expect(prevStepId("profile", all)).toBeNull();
  });

  it("is robust when the current step is no longer visible", () => {
    // e.g. the dependency finished installing while the user was on the step
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: true, profile: "normal" });
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

describe("profile step visibility", () => {
  it("goes straight from the question to the plugins for the no-collection profile", () => {
    // No skin picker and no folder picker before the first song, and without
    // a library the playback step would be a lone crossfade slider.
    const steps = visibleSteps({ missingDepNames: ["yt-dlp"], lastfmInstalled: true, spotifyActive: true, profile: "streaming" });
    expect(steps).toEqual(["profile", "plugins", "dependencies", "spotify", "lastfm"]);
  });

  it("keeps the music and playback steps for the own-music profile", () => {
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: false, profile: "normal" });
    expect(steps).toContain("welcome");
    expect(steps).toContain("music");
    expect(steps).toContain("playback");
  });

  it("keeps the lastfm step for both profiles", () => {
    for (const profile of ONBOARDING_PROFILES) {
      expect(visibleSteps({ missingDepNames: [], lastfmInstalled: true, profile })).toContain("lastfm");
    }
  });

  it("still hides lastfm when not installed, regardless of profile", () => {
    const steps = visibleSteps({ missingDepNames: [], lastfmInstalled: false, profile: "streaming" });
    expect(steps).not.toContain("lastfm");
  });
});

describe("normalizeProfile", () => {
  it("passes valid profiles through", () => {
    expect(normalizeProfile("normal")).toBe("normal");
    expect(normalizeProfile("streaming")).toBe("streaming");
  });

  it("folds the retired video and server profiles into own music", () => {
    // Both were "my own music" with a different first suggestion; a re-run of
    // the wizard on such a profile preselects the card that now covers them.
    expect(normalizeProfile("video")).toBe("normal");
    expect(normalizeProfile("server")).toBe("normal");
  });

  it("falls back to normal for unknown or absent values", () => {
    expect(normalizeProfile("dj")).toBe("normal");
    expect(normalizeProfile(undefined)).toBe("normal");
    expect(normalizeProfile(null)).toBe("normal");
    expect(normalizeProfile(42)).toBe("normal");
  });
});

describe("autoInstallableDeps", () => {
  const optional = { name: "yt-dlp plugin", reason: "merge", required: false };

  it("takes missing, managed tools some plugin requires", () => {
    const deps = [
      dep({ name: "yt-dlp", pluginConsumers: [consumer] }),
      dep({ name: "ffmpeg", pluginConsumers: [optional] }),
      dep({ name: "rqbit", managedAvailable: false, pluginConsumers: [consumer] }),
      dep({ name: "helper", status: "installed", pluginConsumers: [consumer] }),
      dep({ name: "other", pluginConsumers: [] }),
    ];
    // Optional tools stay a click away; a tool with no managed build can't be
    // fetched; an installed one needs nothing.
    expect(autoInstallableDeps(deps)).toEqual(["yt-dlp"]);
  });

  it("leaves a tool nothing can verify to its button", () => {
    // Its install is confirmed every time, so the wizard can't take it silently.
    expect(autoInstallableDeps([dep({ name: "rqbit", verified: false, pluginConsumers: [consumer] })])).toEqual([]);
  });

  it("counts an errored probe as missing", () => {
    expect(autoInstallableDeps([dep({ status: "error", pluginConsumers: [consumer] })])).toEqual(["yt-dlp"]);
  });
});

describe("spotifyConnection", () => {
  it("reads the plugin's sync state", () => {
    expect(spotifyConnection({ syncStatus: "checking", playlistCount: 0 })).toEqual({ state: "checking" });
    expect(spotifyConnection({ syncStatus: "waiting-login", playlistCount: 0 })).toEqual({ state: "signing-in" });
    expect(spotifyConnection({ syncStatus: "running", playlistCount: 0 })).toEqual({ state: "loading" });
    expect(spotifyConnection({ syncStatus: "done", playlistCount: 24 })).toEqual({ state: "ready", playlists: 24, account: null });
    expect(spotifyConnection({ syncStatus: "idle", playlistCount: 0 })).toEqual({ state: "not-connected", signedOut: false });
    expect(spotifyConnection({ syncStatus: "error", playlistCount: 0 })).toEqual({ state: "failed" });
  });

  it("uses the sign-in state when the plugin reports it", () => {
    // After the plugin's quiet first-run check: signed out, nothing synced.
    expect(spotifyConnection({ syncStatus: "idle", playlistCount: 0, auth: "signed-out", account: null }))
      .toEqual({ state: "not-connected", signedOut: true });
    // A confirmed session is connected even before any playlist landed.
    expect(spotifyConnection({ syncStatus: "done", playlistCount: 24, auth: "signed-in", account: " Alex " }))
      .toEqual({ state: "ready", playlists: 24, account: "Alex" });
    expect(spotifyConnection({ syncStatus: "idle", playlistCount: 0, auth: "signed-in", account: "Alex" }))
      .toEqual({ state: "ready", playlists: 0, account: "Alex" });
    // An account is only believed alongside signed-in.
    expect(spotifyConnection({ syncStatus: "done", playlistCount: 2, auth: "signed-out", account: "Alex" }))
      .toEqual({ state: "ready", playlists: 2, account: null });
  });

  it("treats playlists already synced as connected, even after a failed refresh", () => {
    expect(spotifyConnection({ syncStatus: "idle", playlistCount: 3 })).toEqual({ state: "ready", playlists: 3, account: null });
    expect(spotifyConnection({ syncStatus: "error", playlistCount: 3 })).toEqual({ state: "ready", playlists: 3, account: null });
  });

  it("says unknown for an answer it can't read", () => {
    expect(spotifyConnection(null)).toEqual({ state: "unknown" });
    expect(spotifyConnection("busy")).toEqual({ state: "unknown" });
    expect(spotifyConnection({ syncStatus: "something-new" })).toEqual({ state: "unknown" });
  });
});

describe("joinNames", () => {
  it("renders one, two, and three names as prose", () => {
    expect(joinNames(["yt-dlp"])).toBe("yt-dlp");
    expect(joinNames(["yt-dlp", "ffmpeg"])).toBe("yt-dlp and ffmpeg");
    expect(joinNames(["a", "b", "c"])).toBe("a, b and c");
  });

  it("renders nothing for an empty list", () => {
    expect(joinNames([])).toBe("");
  });
});

describe("PROFILE_PRESETS", () => {
  it("offers exactly two choices: own music, or none", () => {
    expect([...ONBOARDING_PROFILES]).toEqual(["normal", "streaming"]);
    expect(PROFILE_PRESETS.normal.hasLocalMusic).toBe(true);
    expect(PROFILE_PRESETS.streaming.hasLocalMusic).toBe(false);
  });

  it("does not advertise sources the plugins step filters out", () => {
    // tidal-browse is `stability: experimental`, and filterOnboardingEntries
    // drops experimental entries — so naming TIDAL on the card promised a
    // source that never appeared in the list below it.
    expect(PROFILE_PRESETS.streaming.description).not.toMatch(/tidal/i);
  });

  it("does the setup work itself only for the no-collection profile", () => {
    // With no local music the plugins and their tools are the only route to
    // sound, so Continue installs them; with a library they stay suggestions.
    for (const key of ["installPluginsOnContinue", "autoInstallTools"] as const) {
      expect(PROFILE_PRESETS.streaming[key], key).toBe(true);
      expect(PROFILE_PRESETS.normal[key], key).toBe(false);
    }
  });
});
