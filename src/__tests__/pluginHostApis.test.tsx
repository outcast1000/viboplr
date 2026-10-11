// The host APIs the Community plugin's in-app tab is built on (redesign phase 5):
// interactive `plugin_view` information sections + `setSectionData`, seek-bar
// markers and their permission, and opening a detail page on a tab.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { sanitizeSeekMarkers, mergeSeekMarkers, markerLabelsNear, MAX_SEEK_MARKERS } from "../utils/seekMarkers";
import { onDetailTabRequest, requestDetailTab, takeDetailTab } from "../utils/pendingDetailTab";
import { pluginViewTree, sectionActionPayload } from "../components/renderers/PluginViewSection";
import { saveOwnInfoValue, sectionDataRequest, InfoFetchRequestError, type InfoTypeRow } from "../utils/infoFetchChain";
import { checkPermission, describePermission } from "../pluginWorker/permissions";
import { onInfoValueChanged } from "../utils/infoValueEvents";
import { InformationSections } from "../components/InformationSections";
import { PluginSectionContext } from "../contexts/PluginSectionContext";
import { RetrieveModal } from "../components/RetrieveModal";
import { buildEntityKey, type InfoEntity } from "../types/informationTypes";

beforeEach(() => invoke.mockReset());
afterEach(cleanup);

describe("seek markers", () => {
  it("keeps finite times and plain labels, sorted, capped", () => {
    const out = sanitizeSeekMarkers([
      { at: 30, label: "  the   bridge " },
      { at: -1, label: "negative" },
      { at: Number.NaN },
      null,
      "nope",
      { at: 5, label: 42 },
      { at: 10, label: "x".repeat(300) },
    ]);
    expect(out.map((m) => m.at)).toEqual([5, 10, 30]);
    expect(out[0].label).toBe("");
    expect(out[1].label.length).toBe(160);
    expect(out[2].label).toBe("the bridge");
    expect(sanitizeSeekMarkers("not a list")).toEqual([]);
    const many = Array.from({ length: 500 }, (_, i) => ({ at: i }));
    expect(sanitizeSeekMarkers(many)).toHaveLength(MAX_SEEK_MARKERS);
  });

  it("merges plugins and finds the notes under the pointer", () => {
    const merged = mergeSeekMarkers({ a: [{ at: 100, label: "A" }], b: [{ at: 50, label: "B" }, { at: 101, label: "C" }] });
    expect(merged.map((m) => m.label)).toEqual(["B", "A", "C"]);
    // 300s track: tolerance is max(1s, 0.8%) = 2.4s.
    expect(markerLabelsNear(merged, 100.5, 300)).toEqual(["A", "C"]);
    expect(markerLabelsNear(merged, 60, 300)).toEqual([]);
    expect(markerLabelsNear(merged, 50, 0)).toEqual([]);
  });
});

describe("detail-page tab requests", () => {
  const song = { kind: "track", name: "Song", artistName: "Band" };
  it("are taken once, for their own page, while fresh", () => {
    requestDetailTab(song, "community", 1000);
    expect(takeDetailTab({ ...song, artistName: "Other" }, 1001)).toBeNull();
    // The wrong page doesn't consume it.
    expect(takeDetailTab(song, 1002)).toBe("community");
    expect(takeDetailTab(song, 1003)).toBeNull();
    requestDetailTab(song, "community", 0);
    expect(takeDetailTab(song, 60_000)).toBeNull();
  });

  it("match names regardless of case and accents, and an album asked for without its artist", () => {
    requestDetailTab({ kind: "artist", name: "bjork" }, "community", 0);
    expect(takeDetailTab({ kind: "artist", name: "Björk" }, 1)).toBe("community");
    requestDetailTab({ kind: "album", name: "homogenic" }, "community", 0);
    expect(takeDetailTab({ kind: "album", name: "Homogenic", artistName: "Björk" }, 1)).toBe("community");
    requestDetailTab({ kind: "album", name: "Homogenic", artistName: "Someone" }, "community", 0);
    expect(takeDetailTab({ kind: "album", name: "Homogenic", artistName: "Björk" }, 1)).toBeNull();
    expect(takeDetailTab({ kind: "artist", name: "Homogenic" }, 2)).toBeNull();
  });

  it("tell a page that is already open", () => {
    const heard = vi.fn();
    const off = onDetailTabRequest(heard);
    requestDetailTab(song, "community");
    off();
    requestDetailTab(song, "community");
    expect(heard).toHaveBeenCalledTimes(1);
    takeDetailTab(song);
  });
});

describe("plugin_view sections", () => {
  it("read the tree from the value or its `view`, nothing else", () => {
    const tree = { type: "text", content: "hi" };
    expect(pluginViewTree(tree)).toEqual(tree);
    expect(pluginViewTree({ view: tree, _meta: {} })).toEqual(tree);
    expect(pluginViewTree({ summary: "prose" })).toBeUndefined();
    expect(pluginViewTree(null)).toBeUndefined();
  });

  it("send the page's entity with every action", () => {
    const entity: InfoEntity = { kind: "track", name: "Song", id: 3, artistName: "Band" };
    const ent = { kind: "track", name: "Song", artistName: "Band", albumTitle: null };
    expect(sectionActionPayload({ itemId: "c1" }, entity)).toEqual({ itemId: "c1", entity: ent });
    expect(sectionActionPayload("typed", entity)).toEqual({ value: "typed", entity: ent });
    expect(sectionActionPayload(undefined, entity)).toEqual({ entity: ent });
    expect(sectionActionPayload({ itemId: "c1" }, null)).toEqual({ itemId: "c1" });
  });

  it("leave a tab request for the page's main tab bar when they are the header strip", () => {
    // The artist page draws the Albums strip (header placement) before its tab
    // bar, for the same entity; the strip must not use the request up.
    const entity: InfoEntity = { kind: "artist", name: "Band", id: 0 };
    invoke.mockResolvedValue(null);
    requestDetailTab(entity, "community");
    render(<InformationSections entity={entity} placement="header" pluginSectionsDisabled invokeInfoFetch={vi.fn()} />);
    expect(takeDetailTab(entity)).toBe("community");
  });

  it("render in a tab, route actions to the plugin that drew them, and open on a requested tab", async () => {
    const entity: InfoEntity = { kind: "track", name: "Song", id: 0, artistName: "Band" };
    const types: InfoTypeRow[] = [
      ["lyrics", "Lyrics", "lyrics", 100, 0, [["lrclib", 1]], ""],
      ["community", "Community", "plugin_view", 100, 1, [["community", 9]], ""],
    ];
    const tree = { type: "button", label: "Like · 3", action: "like" };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "info_get_types_for_entity") return types;
      if (cmd === "info_get_values_for_entity") {
        const now = Math.floor(Date.now() / 1000);
        return [
          [1, "lyrics", JSON.stringify({ text: "la", kind: "plain" }), "ok", now],
          [9, "community", JSON.stringify(tree), "ok", now],
        ];
      }
      return null;
    });
    // The Community tab is not the first one; the plugin asked for it.
    requestDetailTab(entity, "community");
    const dispatch = vi.fn();
    render(
      <PluginSectionContext.Provider value={{ dispatch, currentTrack: null, playing: false }}>
        <InformationSections entity={entity} invokeInfoFetch={vi.fn()} pluginNames={new Map([["community", "Vibo Community"]])} />
      </PluginSectionContext.Provider>,
    );
    const button = await screen.findByText("Like · 3");
    fireEvent.click(button);
    expect(dispatch).toHaveBeenCalledWith("community", "like", { entity: { kind: "track", name: "Song", artistName: "Band", albumTitle: null } });
  });

  it("give their track rows the track menus, as the plugin's sidebar views do", async () => {
    const entity: InfoEntity = { kind: "track", name: "Song", id: 0, artistName: "Band" };
    const types: InfoTypeRow[] = [["community", "Community", "plugin_view", 100, 0, [["community", 9]], ""]];
    const tree = { type: "track-row-list", items: [{ id: "r1", title: "Other Song", artistName: "Band", path: "file:///music/other.mp3" }] };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "info_get_types_for_entity") return types;
      if (cmd === "info_get_values_for_entity") return [[9, "community", JSON.stringify(tree), "ok", Math.floor(Date.now() / 1000)]];
      return null;
    });
    const tracks = {
      onPlayTrack: vi.fn(),
      onTrackContextMenu: vi.fn(),
      onTrackRowContextMenu: vi.fn(),
      onTrackRowsDragStart: vi.fn(),
      pluginMenuItems: [],
      onPluginAction: vi.fn(),
    };
    render(
      <PluginSectionContext.Provider value={{ dispatch: vi.fn(), currentTrack: null, playing: false, tracks }}>
        <InformationSections entity={entity} invokeInfoFetch={vi.fn()} />
      </PluginSectionContext.Provider>,
    );
    fireEvent.contextMenu(await screen.findByText("Other Song"));
    expect(tracks.onTrackRowContextMenu).toHaveBeenCalledTimes(1);
    expect(tracks.onTrackRowContextMenu.mock.calls[0][1]).toEqual([expect.objectContaining({ id: "r1", title: "Other Song", path: "file:///music/other.mp3" })]);
  });

  it("preview in the Retrieve modal as they'll draw, not as raw JSON", () => {
    render(
      <RetrieveModal
        modal={{
          kind: "info",
          label: "Community",
          title: "Community",
          entityKind: "track",
          name: "Song",
          displayKind: "plugin_view",
          providers: [],
          currentIndex: 0,
          phase: "paused",
          infoPreview: { type: "text", content: "drawn, not dumped" },
          countdown: null,
          keepOpen: false,
        }}
        onTryNext={vi.fn()}
        onApplyNow={vi.fn()}
        onCancel={vi.fn()}
        onSetKeepOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("drawn, not dumped")).toBeTruthy();
    expect(document.querySelector(".rm-json")).toBeNull();
  });

  it("open on the requested tab under StrictMode too", async () => {
    // StrictMode runs effects twice; the one-shot request must not be taken by
    // the first run and then reset to the first tab by the second.
    const entity: InfoEntity = { kind: "track", name: "Song", id: 0, artistName: "Band" };
    const types: InfoTypeRow[] = [
      ["lyrics", "Lyrics", "lyrics", 100, 0, [["lrclib", 1]], ""],
      ["community", "Community", "plugin_view", 100, 1, [["community", 9]], ""],
    ];
    const now = Math.floor(Date.now() / 1000);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "info_get_types_for_entity") return types;
      if (cmd === "info_get_values_for_entity") {
        return [
          [1, "lyrics", JSON.stringify({ text: "la", kind: "plain" }), "ok", now],
          [9, "community", JSON.stringify({ type: "text", content: "the community tab" }), "ok", now],
        ];
      }
      return null;
    });
    requestDetailTab(entity, "community");
    render(
      <StrictMode>
        <InformationSections entity={entity} invokeInfoFetch={vi.fn()} />
      </StrictMode>,
    );
    expect(await screen.findByText("the community tab")).toBeTruthy();
  });

  it("keep the requested tab when the navigation respells the page, not when it changes", async () => {
    // A page built from a name takes the spelling of whatever opened it: the
    // plugin asks for "bjork" on the open "Björk" page — same page, same tab.
    const types: InfoTypeRow[] = [
      ["artist_bio", "About", "rich_text", 100, 0, [["lastfm", 1]], ""],
      ["community", "Community", "plugin_view", 100, 1, [["community", 9]], ""],
    ];
    const now = Math.floor(Date.now() / 1000);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "info_get_types_for_entity") return types;
      if (cmd === "info_get_values_for_entity") {
        return [
          [1, "artist_bio", JSON.stringify({ summary: "the bio" }), "ok", now],
          [9, "community", JSON.stringify({ type: "text", content: "the community tab" }), "ok", now],
        ];
      }
      return null;
    });
    const page = (name: string) => <InformationSections entity={{ kind: "artist", name, id: 0 }} invokeInfoFetch={vi.fn()} />;
    const { rerender } = render(page("Björk"));
    expect(await screen.findByText("the bio")).toBeTruthy();
    act(() => requestDetailTab({ kind: "artist", name: "bjork" }, "community"));
    expect(await screen.findByText("the community tab")).toBeTruthy();

    rerender(page("bjork"));
    await act(async () => {});
    expect(await screen.findByText("the community tab")).toBeTruthy();

    rerender(page("Sigur Rós"));
    expect(await screen.findByText("the bio")).toBeTruthy();
  });

  it("are fetched only once their tab is shown, not because the page opened", async () => {
    // The Community tab asks its server as the signed-in member: opening a
    // song page must not name the song to it before the user goes there.
    const entity: InfoEntity = { kind: "track", name: "Song", id: 0, artistName: "Band" };
    const types: InfoTypeRow[] = [
      ["lyrics", "Lyrics", "lyrics", 100, 0, [["lrclib", 1]], ""],
      ["community", "Community", "plugin_view", 100, 1, [["community", 9]], ""],
    ];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "info_get_types_for_entity") return types;
      if (cmd === "info_get_values_for_entity") return [];
      return null;
    });
    const invokeInfoFetch = vi.fn(async (_pluginId: string, typeId: string) =>
      typeId === "lyrics"
        ? { status: "ok" as const, value: { text: "la", kind: "plain" } }
        : { status: "ok" as const, value: { type: "text", content: "from the plugin" } },
    );
    render(<InformationSections entity={entity} invokeInfoFetch={invokeInfoFetch} />);
    await waitFor(() => expect(invokeInfoFetch).toHaveBeenCalledWith("lrclib", "lyrics", expect.anything(), expect.anything()));
    expect(invokeInfoFetch.mock.calls.some(([, typeId]) => typeId === "community")).toBe(false);
    // Waiting for its tab is not loading: no dot.
    const tab = screen.getByText("Community");
    expect(tab.className).not.toMatch(/\bloading\b/);

    fireEvent.click(tab);
    expect(await screen.findByText("from the plugin")).toBeTruthy();
    expect(invokeInfoFetch.mock.calls.filter(([, typeId]) => typeId === "community")).toHaveLength(1);
  });
});

describe("setSectionData", () => {
  const typeRow: InfoTypeRow = ["community", "Community", "plugin_view", 100, 0, [["community", 9], ["other", 10]], ""];
  const entity: InfoEntity = { kind: "track", name: "Song", id: 0, artistName: "Band" };

  it("writes the plugin's own row only, and announces it", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "info_get_types_for_entity" ? [typeRow] : null));
    const seen: string[] = [];
    const off = onInfoValueChanged((key, typeId) => seen.push(`${key}|${typeId}`));
    await saveOwnInfoValue({ pluginId: "community", typeId: "community", entity, value: { type: "text", content: "liked" } });
    off();
    const writes = invoke.mock.calls.filter(([cmd]) => cmd !== "info_get_types_for_entity");
    expect(writes).toEqual([["info_upsert_value", { informationTypeId: 9, entityKey: buildEntityKey(entity), value: '{"type":"text","content":"liked"}', status: "ok" }]]);
    expect(seen).toEqual([`${buildEntityKey(entity)}|community`]);
  });

  it("keeps the entity exactly as given, and refuses one that can't be a page's", () => {
    const value = { type: "text", content: "hi" };
    // Exactly as given: a trimmed name would be a different page key.
    const ok = sectionDataRequest("community", { kind: "track", name: "Song ", artistName: "Band" }, value);
    expect(buildEntityKey(ok.entity)).toBe("track:Band:Song ");
    // An unknown-artist track has a page too.
    expect(buildEntityKey(sectionDataRequest("community", { kind: "track", name: "Song" }, value).entity)).toBe("track::Song");
    expect(() => sectionDataRequest("community", { kind: "track", name: "Song", artistName: 5 }, value)).toThrow(/artistName must be a string/);
    expect(() => sectionDataRequest("community", { kind: "album", name: "A", albumTitle: {} }, value)).toThrow(/albumTitle must be a string/);
    expect(() => sectionDataRequest("community", { kind: "song", name: "Song" }, value)).toThrow(/kind/);
    expect(() => sectionDataRequest("community", { kind: "track", name: "  " }, value)).toThrow(/name/);
    expect(() => sectionDataRequest("", { kind: "track", name: "Song" }, value)).toThrow(/typeId/);
    expect(() => sectionDataRequest("community", { kind: "track", name: "Song" }, [value])).toThrow(/data must be an object/);
  });

  it("refuses a type the plugin doesn't provide", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "info_get_types_for_entity" ? [typeRow] : null));
    await expect(saveOwnInfoValue({ pluginId: "intruder", typeId: "community", entity, value: {} })).rejects.toBeInstanceOf(InfoFetchRequestError);
    await expect(saveOwnInfoValue({ pluginId: "community", typeId: "lyrics", entity, value: {} })).rejects.toBeInstanceOf(InfoFetchRequestError);
    await waitFor(() => expect(invoke).not.toHaveBeenCalledWith("info_upsert_value", expect.anything()));
  });
});

describe("permissions", () => {
  it("gate markers behind their own grant", () => {
    expect(() => checkPermission("p", ["playback:read"], "playback.setMarkers", ["q:1", []])).toThrow(/playback:markers/);
    expect(() => checkPermission("p", ["playback:markers"], "playback.setMarkers", ["q:1", []])).not.toThrow();
    // Own-scoped: a plugin's own tab and opening a page need nothing.
    expect(() => checkPermission("p", [], "informationTypes.setSectionData", [])).not.toThrow();
    expect(() => checkPermission("p", [], "ui.navigateToEntity", [])).not.toThrow();
    expect(describePermission("playback:markers").label).toBe("Mark moments on the seek bar");
  });
});
