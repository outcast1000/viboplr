import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, fireEvent, screen } from "@testing-library/react";
import { PluginViewRenderer } from "../components/PluginViewRenderer";
import { isChatImageSrc, stepsSummary } from "../components/pluginViews/PluginChat";
import type { PluginChatNode, PluginViewData } from "../types/plugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  safeUnlisten: () => {},
  combineUnlisten: () => () => {},
}));

// jsdom has no layout, so scrollIntoView is missing.
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

function chat(over: Partial<PluginChatNode> = {}): PluginChatNode {
  return { type: "chat", messages: [], composer: { action: "send", stopAction: "stop", newAction: "new-chat", footer: "qwen3", footerAction: "open-settings" }, ...over };
}

// Rendered through the RENDERER, wrapped the way the LLM plugin sends it
// (tabs hoisted, then a layout holding only the chat) — that wrapping is what
// selects the full-height mode.
function view(node: PluginChatNode): PluginViewData {
  return {
    type: "layout",
    direction: "vertical",
    children: [{ type: "tabs", tabs: [{ id: "chat", label: "Chat" }], activeTab: "chat", action: "tab" }, node],
  };
}

describe("plugin chat node", () => {
  it("takes the full height when it is the whole body", () => {
    const { container } = render(<PluginViewRenderer pluginName="AI" currentTrack={null} data={view(chat())} />);
    expect(container.querySelector(".plugin-view--chat .plugin-chat--fill")).not.toBeNull();
  });

  it("sends the draft on Enter and clears it; Shift+Enter does not send", () => {
    const onAction = vi.fn();
    render(<PluginViewRenderer pluginName="AI" currentTrack={null} data={view(chat())} onAction={onAction} />);
    const box = screen.getByPlaceholderText("Write a message…") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "play something" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onAction).toHaveBeenCalledWith("send", { query: "play something" });
    expect(box.value).toBe("");
  });

  it("turns Send into Stop while the turn runs", () => {
    const onAction = vi.fn();
    render(<PluginViewRenderer pluginName="AI" currentTrack={null} data={view(chat({ status: { label: "Thinking…", since: Date.now() } }))} onAction={onAction} />);
    fireEvent.click(screen.getByLabelText("Stop"));
    expect(onAction).toHaveBeenCalledWith("stop");
    expect(screen.queryByLabelText("Send")).toBeNull();
  });

  it("folds tool steps until the summary is clicked", () => {
    const node = chat({
      messages: [
        { id: "u1", role: "user", text: "rain music" },
        { id: "a1", role: "assistant", text: "Playing **it**.", steps: [
          { label: "search_library(query: \"rain\")", status: "ok", detail: "{\"query\":\"rain\"}" },
          { label: "play_tracks(trackIds: [3])", status: "ok" },
        ] },
      ],
    });
    render(<PluginViewRenderer pluginName="AI" currentTrack={null} data={view(node)} />);
    expect(screen.getByText("Used 2 tools")).toBeTruthy();
    expect(screen.queryByText("play_tracks(trackIds: [3])")).toBeNull();
    fireEvent.click(screen.getByText("Used 2 tools"));
    expect(screen.getByText("play_tracks(trackIds: [3])")).toBeTruthy();
    // The reply is markdown, rendered as elements — not as literal asterisks.
    expect(screen.getByText("it").tagName).toBe("STRONG");
  });

  it("routes the approval card's buttons to the plugin", () => {
    const onAction = vi.fn();
    const node = chat({ approval: { title: "Approve this action?", message: "play_tracks(trackIds: [3])", approveAction: "approve", denyAction: "deny" } });
    render(<PluginViewRenderer pluginName="AI" currentTrack={null} data={view(node)} onAction={onAction} />);
    fireEvent.click(screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Deny"));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(["approve", "deny"]);
  });

  it("shows suggestions on an empty thread", () => {
    const onAction = vi.fn();
    const node = chat({ empty: { title: "What should we play?", suggestions: [{ label: "Liked but forgotten", action: "quick", data: { id: "q" } }] } });
    render(<PluginViewRenderer pluginName="AI" currentTrack={null} data={view(node)} onAction={onAction} />);
    fireEvent.click(screen.getByText("Liked but forgotten"));
    expect(onAction).toHaveBeenCalledWith("quick", { id: "q" });
  });
});

describe("chat images", () => {
  it("shows inline and https images, drops local paths and plain http", () => {
    const node = chat({
      messages: [{ id: "a1", role: "assistant", text: "Here she is.", images: [
        { src: "data:image/jpeg;base64,/9j/4AAQ", alt: "Björk" },
        { src: "https://example.org/a.jpg", alt: "remote" },
        { src: "file:///Users/x/secret.jpg", alt: "local" },
        { src: "http://tracker.example/p.gif", alt: "plain http" },
      ] }],
    });
    render(<PluginViewRenderer pluginName="AI" currentTrack={null} data={view(node)} />);
    const alts = screen.getAllByRole("img").map((i) => i.getAttribute("alt"));
    expect(alts).toEqual(["Björk", "remote"]);
  });

  it("validates sources", () => {
    expect(isChatImageSrc("data:image/png;base64,AAAA")).toBe(true);
    expect(isChatImageSrc("data:text/html;base64,AAAA")).toBe(false);
    expect(isChatImageSrc("javascript:alert(1)")).toBe(false);
    expect(isChatImageSrc(undefined)).toBe(false);
  });
});

describe("stepsSummary", () => {
  it("names the running step, else counts tools and failures", () => {
    expect(stepsSummary([{ label: "a", status: "ok" }, { label: "b()", status: "running" }])).toBe("b()");
    expect(stepsSummary([{ label: "a", status: "ok" }])).toBe("Used 1 tool");
    expect(stepsSummary([{ label: "x", status: "note" }, { label: "a", status: "error" }, { label: "b", status: "declined" }])).toBe("Used 2 tools · 1 failed · 1 declined");
  });
});
