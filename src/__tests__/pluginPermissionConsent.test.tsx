import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { PluginInstallModal } from "../components/PluginInstallModal";
import { PluginPermissionPrompt } from "../components/PluginPermissionPrompt";

afterEach(cleanup);

const done = { id: "p", name: "Demo", phase: "done" as const, needsEnable: true };

describe("PluginInstallModal — asking at installation", () => {
  it("lists what the plugin asks for and offers Allow and enable", () => {
    const onEnable = vi.fn();
    render(
      <PluginInstallModal
        flow={{ ...done, permissions: ["network:lrclib.net", "exec:yt-dlp"] }}
        onCancel={vi.fn()} onEnable={onEnable} onClose={vi.fn()} onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Connect to lrclib.net")).toBeTruthy();
    expect(screen.getByText(/can't do anything outside this list/)).toBeTruthy();
    // exec is sensitive and is flagged as such.
    expect(screen.getByText("sensitive")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow and enable" }));
    expect(onEnable).toHaveBeenCalledTimes(1);
  });

  it("keeps the plain Enable step for a plugin that asks for nothing", () => {
    render(
      <PluginInstallModal flow={{ ...done, permissions: [] }} onCancel={vi.fn()} onEnable={vi.fn()} onClose={vi.fn()} onRetry={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Enable" })).toBeTruthy();
    expect(screen.queryByText(/asks for the permissions/)).toBeNull();
  });

  it("Not now enables nothing", () => {
    const onEnable = vi.fn();
    const onClose = vi.fn();
    render(
      <PluginInstallModal flow={{ ...done, permissions: ["library:read"] }} onCancel={vi.fn()} onEnable={onEnable} onClose={onClose} onRetry={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onEnable).not.toHaveBeenCalled();
  });
});

describe("PluginPermissionPrompt — asking after an update", () => {
  it("marks only the new permissions on an update that asks for more", () => {
    render(
      <PluginPermissionPrompt
        pluginName="Demo" mode="update"
        requested={["network:lrclib.net", "library:read"]} pending={["library:read"]}
        onAllow={vi.fn(async () => {})} onNotNow={vi.fn()}
      />,
    );
    expect(screen.getByText("Demo needs new permissions")).toBeTruthy();
    expect(screen.getAllByText("new")).toHaveLength(1);
    expect(screen.getByText(/asks for more than you allowed before/)).toBeTruthy();
  });

  it("an update moving a plugin to the worker runtime asks for everything, unbadged", () => {
    render(
      <PluginPermissionPrompt
        pluginName="Demo" mode="update"
        requested={["network:lrclib.net", "library:read"]} pending={["network:lrclib.net", "library:read"]}
        onAllow={vi.fn(async () => {})} onNotNow={vi.fn()}
      />,
    );
    expect(screen.queryByText("new")).toBeNull();
    expect(screen.getByRole("button", { name: "Allow and start" })).toBeTruthy();
  });

  it("Allow runs the grant and disables the buttons while it does", async () => {
    let finish: () => void = () => {};
    const onAllow = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    render(
      <PluginPermissionPrompt pluginName="Demo" mode="install" requested={["library:read"]} pending={["library:read"]} onAllow={onAllow} onNotNow={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Allow and enable" }));
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Not now" }) as HTMLButtonElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect((screen.getByRole("button", { name: "Not now" }) as HTMLButtonElement).disabled).toBe(false));
  });
});
