// The Retrieve modal after every provider came back empty: it shows the plugins
// that could find the image / information, and it waits for the user instead
// of auto-closing in 10s while there are some to read. A found result that then
// failed to apply is not "nothing found" and gets no suggestions.
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

import { useRetrieveModal, type RetrieveModalData } from "../hooks/useRetrieveModal";
import { RetrieveModal } from "../components/RetrieveModal";
import type { ProviderSuggestion } from "../utils/providerSuggestions";

afterEach(cleanup);

const DDG: ProviderSuggestion = { id: "duckduckgo", name: "DuckDuckGo", description: "Web image search", action: "install", experimental: true };

function exhausted(over: Partial<RetrieveModalData> = {}): RetrieveModalData {
  return {
    kind: "image", label: "Retrieve artist image", title: "Portishead", entityKind: "artist", name: "Portishead",
    providers: [{ id: "artwork:deezer", name: "Deezer", pluginId: "artwork", status: "not_found" }],
    currentIndex: 0, phase: "exhausted", countdown: null, keepOpen: false, message: "No result found from any provider",
    ...over,
  };
}

function show(modal: RetrieveModalData, suggestions: ProviderSuggestion[] | null) {
  const onShowPlugin = vi.fn();
  render(
    <RetrieveModal
      modal={modal}
      onTryNext={() => {}} onApplyNow={() => {}} onCancel={() => {}} onSetKeepOpen={() => {}}
      suggestions={suggestions}
      onShowPlugin={onShowPlugin}
    />,
  );
  return onShowPlugin;
}

describe("RetrieveModal suggestions", () => {
  it("shows them once nothing was found, and opens the one picked", () => {
    const onShowPlugin = show(exhausted(), [DDG]);
    expect(screen.getByText(/None of your providers had it\. These plugins can look for artist images too/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View plugin…" }));
    expect(onShowPlugin).toHaveBeenCalledWith("duckduckgo");
  });

  it("words the no-provider case", () => {
    show(exhausted({ kind: "info", entityKind: "track", providers: [], infoTypeId: "lyrics" }), [DDG]);
    expect(screen.getByText(/No provider for this information is switched on/)).toBeTruthy();
  });

  it("doesn't say the providers had nothing when one of them couldn't be reached", () => {
    show(exhausted({ providers: [
      { id: "a", name: "Deezer", pluginId: "a", status: "error" },
      { id: "b", name: "iTunes", pluginId: "b", status: "not_found" },
    ] }), [DDG]);
    expect(screen.getByText(/Some of your providers couldn't be reached and none had it/)).toBeTruthy();
  });

  it("says nothing while searching, or after a found result failed to apply", () => {
    show(exhausted({ phase: "running" }), [DDG]);
    expect(screen.queryByText("DuckDuckGo")).toBeNull();
    cleanup();
    show(exhausted({ providers: [{ id: "a", name: "Deezer", pluginId: "a", status: "found" }], message: "disk full", applyFailed: true }), [DDG]);
    expect(screen.queryByText("DuckDuckGo")).toBeNull();
  });

  it("still shows them when a found result was passed over with Try next", () => {
    // The hook holds the modal open in this state, so the modal must show
    // something — it used to hide the list on any found row.
    show(exhausted({ providers: [
      { id: "a", name: "Deezer", pluginId: "a", status: "found" },
      { id: "b", name: "iTunes", pluginId: "b", status: "not_found" },
    ] }), [DDG]);
    expect(screen.getByText(/These plugins can also look for artist images/)).toBeTruthy();
    expect(screen.getByText("DuckDuckGo")).toBeTruthy();
  });
});

describe("useRetrieveModal holdOpenWhenExhausted", () => {
  const notFound = vi.fn().mockResolvedValue({ status: "not_found" });
  const open = (hold: boolean) => {
    const { result } = renderHook(() =>
      useRetrieveModal(notFound, vi.fn(), { holdOpenWhenExhausted: () => hold }),
    );
    return result;
  };

  it("doesn't start the auto-close countdown while there are suggestions to read", async () => {
    const result = open(true);
    await act(async () => {
      result.current.openImage({ kind: "artist", name: "Portishead", providers: [["artwork:deezer", 100, 1]], pluginNames: new Map() });
    });
    await vi.waitFor(() => expect(result.current.modal?.phase).toBe("exhausted"));
    expect(result.current.modal?.countdown).toBeNull();
  });

  it("stops the countdown when suggestions arrive after the chain ran out", async () => {
    let hold = false;
    const { result } = renderHook(() =>
      useRetrieveModal(notFound, vi.fn(), { holdOpenWhenExhausted: () => hold }),
    );
    await act(async () => {
      result.current.openImage({ kind: "artist", name: "Portishead", providers: [["artwork:deezer", 100, 1]], pluginNames: new Map() });
    });
    await vi.waitFor(() => expect(result.current.modal?.countdown).toBeGreaterThan(0));
    hold = true; // the gallery index landed
    await vi.waitFor(() => expect(result.current.modal?.countdown).toBeNull(), { timeout: 2500 });
    expect(result.current.modal?.phase).toBe("exhausted");
  });

  it("switching Keep open off still closes, suggestions or not", async () => {
    const result = open(true);
    await act(async () => {
      result.current.openImage({ kind: "artist", name: "Portishead", providers: [["artwork:deezer", 100, 1]], pluginNames: new Map() });
    });
    await vi.waitFor(() => expect(result.current.modal?.phase).toBe("exhausted"));
    act(() => result.current.setKeepOpen(true));
    act(() => result.current.setKeepOpen(false));
    // The hold used to cancel this on the first tick: the switch read off and the modal stayed.
    await new Promise((r) => setTimeout(r, 1200));
    expect(result.current.modal?.countdown).toBeGreaterThan(0);
  });

  it("auto-closes as before when there is nothing to suggest", async () => {
    const result = open(false);
    await act(async () => {
      result.current.openImage({ kind: "artist", name: "Portishead", providers: [["artwork:deezer", 100, 1]], pluginNames: new Map() });
    });
    await vi.waitFor(() => expect(result.current.modal?.phase).toBe("exhausted"));
    await vi.waitFor(() => expect(result.current.modal?.countdown).toBeGreaterThan(0));
  });
});
