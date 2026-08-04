import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import ExtensionsView from "../components/ExtensionsView";
import type { ExtensionItem } from "../types/plugin";
import type { PluginContribution } from "../utils/pluginContributions";

// The Contributions section is the one part of the per-contribution toggle that
// isn't a pure function (pluginContributions.test.ts covers those). It only
// exists inside the plugin detail pane, so drive the real view to get there —
// that also asserts the props actually reach PluginDetail.

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: vi.fn(() => () => {}),
  combineUnlisten: vi.fn(() => () => {}),
  safeUnlisten: vi.fn(),
}));
vi.mock("../store", () => ({
  store: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ytdlp: ExtensionItem = {
  id: "ytdlp",
  kind: "plugin",
  name: "yt-dlp",
  author: "Viboplr",
  version: "1.7.0",
  description: "Play and download from YouTube",
  status: "active",
  source: "user",
};

const contributions: PluginContribution[] = [
  {
    key: "ytdlp:menu:watch",
    pluginId: "ytdlp",
    kind: "menu",
    id: "watch",
    label: "Watch YouTube video",
    detail: "Right-click menu on tracks",
  },
  {
    key: "ytdlp:sidebar:browse",
    pluginId: "ytdlp",
    kind: "sidebar",
    id: "browse",
    label: "YouTube",
    detail: "Sidebar view",
  },
  {
    key: "ytdlp:search:ytdlp-search",
    pluginId: "ytdlp",
    kind: "search",
    id: "ytdlp-search",
    label: "yt-dlp",
    detail: "Global search (Cmd+K)",
  },
  // Belongs to a different plugin — must not appear on yt-dlp's detail pane.
  {
    key: "ffmpeg-tools:menu:convert",
    pluginId: "ffmpeg-tools",
    kind: "menu",
    id: "convert",
    label: "Convert to → MP3",
    detail: "Right-click menu on tracks",
  },
];

function renderDetail(opts?: {
  contributions?: PluginContribution[];
  visibility?: Record<string, boolean>;
  onSet?: (key: string, enabled: boolean) => void;
}) {
  const result = render(
    <ExtensionsView
      allExtensions={[ytdlp]}
      updateCount={0}
      searchQuery=""
      onSetSearchQuery={() => {}}
      installing={new Set()}
      checking={false}
      lastChecked={null}
      onCheckForUpdates={() => {}}
      onUpdateExtension={() => {}}
      onUpdateAll={() => {}}
      onInstallFromGallery={async () => ({ ok: true, kind: "plugin" as const })}
      onUninstall={() => {}}
      onToggleEnabled={() => {}}
      onFetchPluginGallery={() => {}}
      onFetchSkinGallery={() => {}}
      onInstallFromUrl={async () => {}}
      galleryPlugins={[]}
      gallerySkins={[]}
      contributions={opts?.contributions ?? contributions}
      contributionVisibility={opts?.visibility ?? {}}
      onSetContributionEnabled={opts?.onSet}
    />,
  );
  // Open the plugin's detail pane — the Contributions section lives there.
  fireEvent.click(result.getByText("Details"));
  return result;
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll(".ext-contrib-row"));
}

describe("Extensions → Contributions section", () => {
  it("lists only this plugin's contributions, with their explanatory line", () => {
    const { container } = renderDetail();
    const labels = rows(container).map(
      (r) => r.querySelector(".ext-contrib-label")?.textContent,
    );
    expect(labels).toEqual(["Watch YouTube video", "YouTube", "yt-dlp"]);
    expect(labels).not.toContain("Convert to → MP3");
    const details = rows(container).map(
      (r) => r.querySelector(".ext-contrib-detail")?.textContent,
    );
    expect(details).toEqual([
      "Right-click menu on tracks",
      "Sidebar view",
      "Global search (Cmd+K)",
    ]);
  });

  it("renders a switch for every kind, including search providers", () => {
    const { container } = renderDetail();
    const switches = rows(container).map((r) => r.querySelector("[role=switch]"));
    expect(switches.every(Boolean)).toBe(true);
  });

  it("toggles a search provider off with its search-kind key", () => {
    const onSet = vi.fn();
    const { container } = renderDetail({ onSet });
    fireEvent.click(rows(container)[2].querySelector("[role=switch]")!);
    expect(onSet).toHaveBeenCalledWith("ytdlp:search:ytdlp-search", false);
  });

  it("shows a contribution with no saved key as on", () => {
    const { container } = renderDetail({ visibility: {} });
    expect(rows(container)[0].querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe("true");
  });

  it("reflects an explicitly disabled contribution as off", () => {
    const { container } = renderDetail({ visibility: { "ytdlp:menu:watch": false } });
    const switches = rows(container).map((r) => r.querySelector("[role=switch]"));
    expect(switches[0]?.getAttribute("aria-checked")).toBe("false");
    // A sibling contribution is unaffected.
    expect(switches[1]?.getAttribute("aria-checked")).toBe("true");
  });

  it("toggles off with the contribution's own key", () => {
    const onSet = vi.fn();
    const { container } = renderDetail({ onSet });
    fireEvent.click(rows(container)[0].querySelector("[role=switch]")!);
    expect(onSet).toHaveBeenCalledWith("ytdlp:menu:watch", false);
  });

  it("toggles a disabled contribution back on", () => {
    const onSet = vi.fn();
    const { container } = renderDetail({
      visibility: { "ytdlp:menu:watch": false },
      onSet,
    });
    fireEvent.click(rows(container)[0].querySelector("[role=switch]")!);
    expect(onSet).toHaveBeenCalledWith("ytdlp:menu:watch", true);
  });

  it("omits the section entirely for a plugin that contributes nothing", () => {
    const { container } = renderDetail({ contributions: [] });
    expect(container.querySelector(".ext-contrib-list")).toBeNull();
    // The rest of the detail pane still renders.
    expect(container.querySelector(".ext-detail")).not.toBeNull();
  });
});
