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
    onClear: vi.fn(),
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
      "Save", "Save as Playlist", "Export as M3U",
      "Share", "Publish hosted source…", "Save as file (.mixtape)…",
      "Auto-continue settings…",
      "Clear queue",
    ]);
  });

  it("groups save and share as submenus, not flat items", () => {
    const specs = buildQueueHeaderMenuSpecs(makeDeps());
    const save = specs.find((s) => s.kind !== "separator" && s.text === "Save");
    const share = specs.find((s) => s.kind !== "separator" && s.text === "Share");
    expect(save?.kind).toBe("submenu");
    expect(share?.kind).toBe("submenu");
  });

  // "Clear queue" is the only route to clearing the queue, and it lives
  // behind a native menu — so this wiring is otherwise untested.
  it("wires Clear queue to onClear", () => {
    const deps = makeDeps();
    invokeItem(buildQueueHeaderMenuSpecs(deps), "Clear queue");
    expect(deps.onClear).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Load playlist…", "onLoadPlaylist"],
    ["Save as Playlist", "onSaveToPlaylists"],
    ["Export as M3U", "onSaveAsM3U"],
    ["Publish hosted source…", "onPublishQueue"],
    ["Save as file (.mixtape)…", "onExportAsMixtape"],
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

  it("separates the destructive Clear from the rest", () => {
    const specs = buildQueueHeaderMenuSpecs(makeDeps());
    const clearAt = specs.findIndex((s) => s.kind !== "separator" && s.text === "Clear queue");
    expect(specs[clearAt - 1].kind).toBe("separator");
  });
});
