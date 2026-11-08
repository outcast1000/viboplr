import { describe, it, expect, vi } from "vitest";
import { buildQueueHeaderMenuSpecs, type QueueHeaderMenuDeps } from "../contextMenu/buildQueueHeaderMenuSpecs";
import type { MenuItemSpec } from "../nativeMenu";

function makeDeps(overrides: Partial<QueueHeaderMenuDeps> = {}): QueueHeaderMenuDeps {
  return {
    preferVideo: false,
    onTogglePreferVideo: vi.fn(),
    onLoadPlaylist: vi.fn(),
    onSaveToPlaylists: vi.fn(),
    onSaveAsM3U: vi.fn(),
    onPublishQueue: vi.fn(),
    onExportAsMixtape: vi.fn(),
    onOpenAutoContinueSettings: vi.fn(),
    ...overrides,
  };
}

/** Flatten the spec tree to visible texts (separators dropped). */
function texts(specs: MenuItemSpec[]): string[] {
  const out: string[] = [];
  const walk = (arr: MenuItemSpec[]) => arr.forEach((s) => {
    if (s.kind === "separator") return;
    out.push(s.text);
    if (s.kind === "submenu") walk(s.items);
  });
  walk(specs);
  return out;
}

/** Find an item by text anywhere in the tree and fire its action. */
function invokeItem(specs: MenuItemSpec[], text: string): void {
  const find = (arr: MenuItemSpec[]): MenuItemSpec | null => {
    for (const s of arr) {
      if (s.kind === "separator") continue;
      if (s.text === text) return s;
      if (s.kind === "submenu") {
        const hit = find(s.items);
        if (hit) return hit;
      }
    }
    return null;
  };
  const item = find(specs);
  if (!item || item.kind === "separator" || item.kind === "submenu") {
    throw new Error(`No actionable item named "${text}"`);
  }
  item.action();
}

describe("buildQueueHeaderMenuSpecs", () => {
  it("offers every queue-level action", () => {
    expect(texts(buildQueueHeaderMenuSpecs(makeDeps()))).toEqual([
      "Prefer video",
      "Load playlist…",
      "Save", "Save as Playlist", "Export as M3U", "Export as Mixtape…",
      "Publish hosted source…",
      "Auto-continue settings…",
    ]);
  });

  // Every file the queue can be written to sits under Save; publishing is the
  // one action that puts it somewhere others can reach, so it stands alone.
  it("groups the file exports under a Save submenu, Publish top-level", () => {
    const specs = buildQueueHeaderMenuSpecs(makeDeps());
    const save = specs.find((s) => s.kind !== "separator" && s.text === "Save");
    expect(save?.kind).toBe("submenu");
    expect(save?.kind === "submenu" && save.items.map((s) => s.kind !== "separator" && s.text)).toEqual([
      "Save as Playlist", "Export as M3U", "Export as Mixtape…",
    ]);
    const publish = specs.find((s) => s.kind !== "separator" && s.text === "Publish hosted source…");
    expect(publish?.kind).toBe("item");
  });

  it.each([
    ["Load playlist…", "onLoadPlaylist"],
    ["Save as Playlist", "onSaveToPlaylists"],
    ["Export as M3U", "onSaveAsM3U"],
    ["Publish hosted source…", "onPublishQueue"],
    ["Export as Mixtape…", "onExportAsMixtape"],
    ["Auto-continue settings…", "onOpenAutoContinueSettings"],
    ["Prefer video", "onTogglePreferVideo"],
  ] as const)("wires %s to %s", (label, key) => {
    const deps = makeDeps();
    invokeItem(buildQueueHeaderMenuSpecs(deps), label);
    expect(deps[key]).toHaveBeenCalledTimes(1);
  });

  // Prefer video is a check item reflecting the live mode. It can sit behind
  // the ⋯ because it is never on silently: the list's own banner announces it
  // with a Turn off button (see QueuePanel).
  it.each([true, false])("shows Prefer video checked=%s from the live mode", (on) => {
    const item = buildQueueHeaderMenuSpecs(makeDeps({ preferVideo: on }))[0];
    expect(item).toMatchObject({ kind: "check", text: "Prefer video", checked: on });
  });

  // There is no Clear: the queue history undoes a replacement (queue.md
  // "Queue History"), and only the control API still empties the queue.
  it("offers no Clear", () => {
    expect(texts(buildQueueHeaderMenuSpecs(makeDeps()))).not.toContain("Clear queue");
  });

  // Below 230px the header hides Back / Forward (QueuePanel.css); QueuePanel
  // then passes `history` and they lead the menu, so they are never out of reach.
  describe("folded queue history", () => {
    const history = (back: string | null, forward: string | null) => ({
      back: back ? { name: back } : null,
      forward: forward ? { name: forward } : null,
      onBack: vi.fn(),
      onForward: vi.fn(),
    });

    it("leads with Back / Forward naming their cards, then a separator", () => {
      const specs = buildQueueHeaderMenuSpecs(makeDeps({ history: history("Radio: Teardrop", "Kind of Blue") }));
      expect(specs[0]).toMatchObject({ kind: "item", text: "Back to: Radio: Teardrop", enabled: true });
      expect(specs[1]).toMatchObject({ kind: "item", text: "Forward to: Kind of Blue", enabled: true });
      expect(specs[2]).toEqual({ kind: "separator" });
      expect(specs[3]).toMatchObject({ kind: "check", text: "Prefer video" });
    });

    it("disables an end with no card, keeping the item in place", () => {
      const specs = buildQueueHeaderMenuSpecs(makeDeps({ history: history(null, null) }));
      expect(specs[0]).toMatchObject({ text: "Back: no earlier queue", enabled: false });
      expect(specs[1]).toMatchObject({ text: "Forward: no later queue", enabled: false });
    });

    it("wires Back and Forward to the history callbacks", () => {
      const h = history("A", "B");
      const specs = buildQueueHeaderMenuSpecs(makeDeps({ history: h }));
      invokeItem(specs, "Back to: A");
      invokeItem(specs, "Forward to: B");
      expect(h.onBack).toHaveBeenCalledTimes(1);
      expect(h.onForward).toHaveBeenCalledTimes(1);
    });

    it("names the keyboard shortcut, as the button tooltips do", () => {
      const specs = buildQueueHeaderMenuSpecs(makeDeps({
        history: { ...history("A", null), backShortcut: "⌘[", forwardShortcut: "⌘]" },
      }));
      expect(specs[0]).toMatchObject({ text: "Back to: A (⌘[)" });
      expect(specs[1]).toMatchObject({ text: "Forward: no later queue (⌘])" });
    });

    it("is absent when the header shows the buttons", () => {
      const t = texts(buildQueueHeaderMenuSpecs(makeDeps({ history: null })));
      expect(t.some((x) => x.startsWith("Back") || x.startsWith("Forward"))).toBe(false);
    });
  });
});
