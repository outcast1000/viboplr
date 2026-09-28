import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import {
  manifestImage,
  resolvePluginViewHeader,
  runtimeImage,
  sanitizeViewHeader,
  VIEW_HEADER_LIMITS,
} from "../utils/pluginViewHeader";
import { isSvgPathData, pluginIconPath, PLUGIN_ICON_PATHS } from "../utils/pluginIconPath";
import { PluginViewHeader } from "../components/PluginViewHeader";
import type { PluginManifest } from "../types/plugin";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

const SOULSEEK_ICON = "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0";

function manifest(extra: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "slskd",
    name: "Soulseek",
    version: "0.9.6",
    icon: SOULSEEK_ICON,
    contributes: { sidebarItems: [{ id: "slskd-browse", label: "Soulseek", icon: SOULSEEK_ICON }] },
    ...extra,
  };
}

describe("resolvePluginViewHeader", () => {
  it("needs nothing from the plugin: the manifest name and icon", () => {
    const h = resolvePluginViewHeader({ manifest: manifest(), viewId: "slskd-browse", runtime: null });
    expect(h).toMatchObject({ hidden: false, title: "Soulseek", viewLabel: null, subtitle: null, status: null, actions: [], logo: null, banner: null });
    expect(h.iconPath).toBe(SOULSEEK_ICON);
  });

  it("names the view only when the plugin has more than one", () => {
    const two = manifest({ name: "Spotify", contributes: { sidebarItems: [
      { id: "browse", label: "Browse", icon: "spotify" },
      { id: "library", label: "Library", icon: "spotify" },
    ] } });
    expect(resolvePluginViewHeader({ manifest: two, viewId: "library", runtime: null }).viewLabel).toBe("Library");
    const same = manifest({ contributes: { sidebarItems: [
      { id: "a", label: "Soulseek", icon: "x" },
      { id: "b", label: "Other", icon: "x" },
    ] } });
    expect(resolvePluginViewHeader({ manifest: same, viewId: "a", runtime: null }).viewLabel, "a label equal to the name adds nothing").toBeNull();
  });

  it("layers manifest, then the view's own header, then runtime", () => {
    const m = manifest({
      viewHeader: { subtitle: "via slskd", logo: "assets/logo.png", banner: "assets/banner.jpg" },
      contributes: { sidebarItems: [{ id: "slskd-browse", label: "Soulseek", icon: SOULSEEK_ICON, header: { subtitle: "Search & download" } }] },
    });
    const noRuntime = resolvePluginViewHeader({ manifest: m, viewId: "slskd-browse", runtime: null });
    expect(noRuntime.subtitle).toBe("Search & download");
    expect(noRuntime.logo).toEqual({ kind: "plugin-file", path: "assets/logo.png" });

    const runtime = sanitizeViewHeader({ subtitle: "Connected as outcast1000", banner: "https://example.com/b.jpg", status: { variant: "success", label: "Ready" } });
    const withRuntime = resolvePluginViewHeader({ manifest: m, viewId: "slskd-browse", runtime });
    expect(withRuntime.subtitle).toBe("Connected as outcast1000");
    expect(withRuntime.banner).toEqual({ kind: "src", value: "https://example.com/b.jpg" });
    expect(withRuntime.logo, "fields the runtime left out keep the manifest value").toEqual({ kind: "plugin-file", path: "assets/logo.png" });
    expect(withRuntime.status).toEqual({ variant: "success", label: "Ready" });
  });

  it("an explicit empty runtime subtitle clears the manifest's", () => {
    const m = manifest({ viewHeader: { subtitle: "via slskd" } });
    const h = resolvePluginViewHeader({ manifest: m, viewId: "slskd-browse", runtime: sanitizeViewHeader({ subtitle: "" }) });
    expect(h.subtitle).toBeNull();
  });

  it("can be turned off per view, and back on at runtime", () => {
    const m = manifest({ contributes: { sidebarItems: [{ id: "slskd-browse", label: "S", icon: "x", header: { hidden: true } }] } });
    expect(resolvePluginViewHeader({ manifest: m, viewId: "slskd-browse", runtime: null }).hidden).toBe(true);
    expect(resolvePluginViewHeader({ manifest: m, viewId: "slskd-browse", runtime: { hidden: false } }).hidden).toBe(false);
  });

  it("falls back to the sidebar glyph when the manifest has no icon", () => {
    const m = manifest({ icon: undefined, contributes: { sidebarItems: [{ id: "v", label: "V", icon: "music" }] } });
    expect(resolvePluginViewHeader({ manifest: m, viewId: "v", runtime: null }).iconPath).toBe(PLUGIN_ICON_PATHS.music);
  });
});

describe("sanitizeViewHeader", () => {
  it("null or a non-object means back to the manifest", () => {
    expect(sanitizeViewHeader(null)).toBeNull();
    expect(sanitizeViewHeader("Soulseek")).toBeNull();
    expect(sanitizeViewHeader([])).toBeNull();
  });

  it("keeps at most two valid buttons and drops the rest", () => {
    const h = sanitizeViewHeader({ actions: [
      { label: "Refresh", action: "refresh" },
      { label: "", action: "nolabel" },
      { label: "No action" },
      { label: "Start slskd", action: "roadie-start", variant: "accent", disabled: true },
      { label: "Third", action: "third" },
    ] });
    expect(h?.actions).toEqual([
      { label: "Refresh", action: "refresh", variant: "secondary", disabled: false },
      { label: "Start slskd", action: "roadie-start", variant: "accent", disabled: true },
    ]);
  });

  it("clamps text and falls back to a muted status for an unknown variant", () => {
    const h = sanitizeViewHeader({
      subtitle: "x".repeat(500),
      status: { variant: "purple", label: "Up" },
      actions: [{ label: "A very long button label indeed", action: "a" }],
    });
    expect(h?.subtitle?.length).toBe(VIEW_HEADER_LIMITS.subtitle);
    expect(h?.subtitle?.endsWith("…")).toBe(true);
    expect(h?.status).toEqual({ variant: "muted", label: "Up" });
    expect(h?.actions?.[0].label.length).toBeLessThanOrEqual(VIEW_HEADER_LIMITS.actionLabel);
  });

  it("a status without a label is no status; null clears it", () => {
    expect(sanitizeViewHeader({ status: { variant: "success" } })?.status).toBeUndefined();
    expect(sanitizeViewHeader({ status: null })?.status).toBeNull();
  });
});

describe("header images", () => {
  it("a manifest image is a path inside the plugin folder, nothing else", () => {
    expect(manifestImage("assets/logo.png")).toEqual({ kind: "plugin-file", path: "assets/logo.png" });
    expect(manifestImage("assets\\logo.png")).toEqual({ kind: "plugin-file", path: "assets/logo.png" });
    for (const bad of ["../logo.png", "/abs/logo.png", "C:/logo.png", "https://x/y.png", "data:image/png;base64,AA", "a//b.png", "", 42]) {
      expect(manifestImage(bad), String(bad)).toBeNull();
    }
  });

  it("a runtime image may also be a URL, an inline image or a stored file", () => {
    expect(runtimeImage("https://x/y.png")).toEqual({ kind: "src", value: "https://x/y.png" });
    expect(runtimeImage("data:image/svg+xml;utf8,<svg/>")).toEqual({ kind: "src", value: "data:image/svg+xml;utf8,<svg/>" });
    expect(runtimeImage("/Users/me/Library/viboplr/plugins/tidal/covers/m.jpg")?.kind).toBe("src");
    expect(runtimeImage("assets/logo.png")).toEqual({ kind: "plugin-file", path: "assets/logo.png" });
    expect(runtimeImage("javascript:alert(1)")).toBeNull();
    expect(runtimeImage("data:text/html,<b>x</b>")).toBeNull();
  });
});

describe("pluginIconPath", () => {
  it("tells path data from glyph names by the leading moveto", () => {
    expect(isSvgPathData(SOULSEEK_ICON)).toBe(true);
    expect(isSvgPathData("music"), "a name that merely starts with m").toBe(false);
    expect(isSvgPathData("chart-bar")).toBe(false);
    expect(pluginIconPath("music")).toBe(PLUGIN_ICON_PATHS.music);
    expect(pluginIconPath("chart-bar")).toBe(PLUGIN_ICON_PATHS["chart-bar"]);
    expect(pluginIconPath("nope")).toBe(PLUGIN_ICON_PATHS.puzzle);
    expect(pluginIconPath(undefined)).toBe(PLUGIN_ICON_PATHS.puzzle);
  });
});

describe("<PluginViewHeader>", () => {
  it("draws the name, subtitle, status and buttons, and routes a click to the plugin", () => {
    const onAction = vi.fn();
    const header = resolvePluginViewHeader({
      manifest: manifest(),
      viewId: "slskd-browse",
      runtime: sanitizeViewHeader({
        subtitle: "Connected as outcast1000",
        status: { variant: "success", label: "Ready" },
        actions: [{ label: "Open slskd", action: "open-slskd" }],
      }),
    });
    const { getByText, getByRole } = render(<PluginViewHeader pluginId="slskd" header={header} onAction={onAction} />);
    expect(getByText("Soulseek")).toBeTruthy();
    expect(getByText("Connected as outcast1000")).toBeTruthy();
    expect(getByRole("status").textContent).toBe("Ready");
    fireEvent.click(getByText("Open slskd"));
    expect(onAction).toHaveBeenCalledWith("open-slskd");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("renders nothing when hidden", () => {
    const header = resolvePluginViewHeader({ manifest: manifest(), viewId: "slskd-browse", runtime: { hidden: true } });
    const { container } = render(<PluginViewHeader pluginId="slskd" header={header} onAction={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("asks the backend for a plugin-folder image and shows it as a banner", async () => {
    invoke.mockResolvedValue("/plugins/tidal-browse/assets/banner.jpg");
    const header = resolvePluginViewHeader({
      manifest: manifest({ id: "tidal-browse", name: "TIDAL", viewHeader: { banner: "assets/banner.jpg" } }),
      viewId: "slskd-browse",
      runtime: null,
    });
    const { container } = render(<PluginViewHeader pluginId="tidal-browse" devPath="/dev/tidal" header={header} onAction={() => {}} />);
    await waitFor(() => expect(container.querySelector(".pvh-banner")).not.toBeNull());
    expect(invoke).toHaveBeenCalledWith("plugin_asset_path", { pluginId: "tidal-browse", path: "assets/banner.jpg", devPath: "/dev/tidal" });
    expect(container.querySelector(".pvh-banner")?.getAttribute("src")).toBe("asset:///plugins/tidal-browse/assets/banner.jpg");
    expect(container.querySelector(".plugin-view-header--banner")).not.toBeNull();
  });

  it("a refused image leaves the plain strip, never a broken view", async () => {
    invoke.mockRejectedValue("Plugin image assets/banner.jpg is 900 KB; the limit is 512 KB");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const header = resolvePluginViewHeader({ manifest: manifest({ viewHeader: { banner: "assets/banner.jpg" } }), viewId: "slskd-browse", runtime: null });
    const { container, getByText } = render(<PluginViewHeader pluginId="slskd" header={header} onAction={() => {}} />);
    await waitFor(() => expect(errors).toHaveBeenCalled());
    expect(container.querySelector(".pvh-banner")).toBeNull();
    expect(getByText("Soulseek")).toBeTruthy();
    errors.mockRestore();
  });
});
