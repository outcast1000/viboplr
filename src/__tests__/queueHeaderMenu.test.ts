import { describe, it, expect, vi } from "vitest";
import { buildQueueHeaderMenuSpecs, type QueueHeaderMenuDeps } from "../contextMenu/buildQueueHeaderMenuSpecs";
import type { MenuItemSpec } from "../nativeMenu";

function makeDeps(overrides: Partial<QueueHeaderMenuDeps> = {}): QueueHeaderMenuDeps {
  return {
    onLoadPlaylist: vi.fn(),
    onSaveToPlaylists: vi.fn(),
    onSaveAsM3U: vi.fn(),
    onPublishQueue: vi.fn(),
    onExportAsMixtape: vi.fn(),
    preferVideoResolution: false,
    onPreferVideoResolutionChange: vi.fn(),
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
      "Load playlist…",
      "Save", "Save as Playlist", "Export as M3U",
      "Share", "Publish hosted source…", "Save as file (.mixtape)…",
      "Prefer video",
      "Clear playlist",
    ]);
  });

  it("groups save and share as submenus, not flat items", () => {
    const specs = buildQueueHeaderMenuSpecs(makeDeps());
    const save = specs.find((s) => s.kind !== "separator" && s.text === "Save");
    const share = specs.find((s) => s.kind !== "separator" && s.text === "Share");
    expect(save?.kind).toBe("submenu");
    expect(share?.kind).toBe("submenu");
  });

  // "Clear playlist" is the only route to clearing the queue, and it lives
  // behind a native menu — so this wiring is otherwise untested.
  it("wires Clear playlist to onClear", () => {
    const deps = makeDeps();
    invokeItem(buildQueueHeaderMenuSpecs(deps), "Clear playlist");
    expect(deps.onClear).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Load playlist…", "onLoadPlaylist"],
    ["Save as Playlist", "onSaveToPlaylists"],
    ["Export as M3U", "onSaveAsM3U"],
    ["Publish hosted source…", "onPublishQueue"],
    ["Save as file (.mixtape)…", "onExportAsMixtape"],
  ] as const)("wires %s to %s", (label, key) => {
    const deps = makeDeps();
    invokeItem(buildQueueHeaderMenuSpecs(deps), label);
    expect(deps[key]).toHaveBeenCalledTimes(1);
  });

  it("reflects the prefer-video flag as the check state", () => {
    const on = buildQueueHeaderMenuSpecs(makeDeps({ preferVideoResolution: true }));
    const item = on.find((s) => s.kind === "check");
    expect(item).toMatchObject({ kind: "check", checked: true });
    const off = buildQueueHeaderMenuSpecs(makeDeps({ preferVideoResolution: false }));
    expect(off.find((s) => s.kind === "check")).toMatchObject({ checked: false });
  });

  it("toggles prefer-video to the opposite of its current value", () => {
    const onChange = vi.fn();
    invokeItem(
      buildQueueHeaderMenuSpecs(makeDeps({ preferVideoResolution: true, onPreferVideoResolutionChange: onChange })),
      "Prefer video",
    );
    expect(onChange).toHaveBeenCalledWith(false);

    onChange.mockClear();
    invokeItem(
      buildQueueHeaderMenuSpecs(makeDeps({ preferVideoResolution: false, onPreferVideoResolutionChange: onChange })),
      "Prefer video",
    );
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("separates the destructive Clear from the rest", () => {
    const specs = buildQueueHeaderMenuSpecs(makeDeps());
    const clearAt = specs.findIndex((s) => s.kind !== "separator" && s.text === "Clear playlist");
    expect(specs[clearAt - 1].kind).toBe("separator");
  });
});
