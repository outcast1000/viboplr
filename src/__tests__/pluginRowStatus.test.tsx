import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PluginViewRenderer } from "../components/PluginViewRenderer";
import type { PluginViewData, TrackRowItem } from "../types/plugin";
import { normalizeRowBadge, rowProgress, rowProgressPercent, ROW_BADGE_MAX_CHARS } from "../utils/pluginRowStatus";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  convertFileSrc: (p: string) => p,
}));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  safeUnlisten: () => {},
  combineUnlisten: () => () => {},
}));

afterEach(cleanup);

describe("normalizeRowBadge", () => {
  it("keeps a label and a known variant", () => {
    expect(normalizeRowBadge({ label: "Waiting", variant: "warning" })).toEqual({ label: "Waiting", variant: "warning", pulse: false });
  });
  it("draws an unknown or missing variant as default rather than dropping the word", () => {
    expect(normalizeRowBadge({ label: "Ready", variant: "neon" })).toEqual({ label: "Ready", variant: "default", pulse: false });
    expect(normalizeRowBadge({ label: "Ready" })).toEqual({ label: "Ready", variant: "default", pulse: false });
  });
  it("drops what it can't draw honestly", () => {
    expect(normalizeRowBadge(null)).toBeNull();
    expect(normalizeRowBadge("Waiting")).toBeNull();
    expect(normalizeRowBadge({ label: "   " })).toBeNull();
    expect(normalizeRowBadge({ label: 42 })).toBeNull();
  });
  it("pulses only for a literal true", () => {
    expect(normalizeRowBadge({ label: "Searching", pulse: true })!.pulse).toBe(true);
    expect(normalizeRowBadge({ label: "Searching", pulse: "yes" })!.pulse).toBe(false);
  });
  it("ellipsises a long label so it can't crowd the subtitle", () => {
    const b = normalizeRowBadge({ label: "x".repeat(60) });
    expect(b!.label.length).toBe(ROW_BADGE_MAX_CHARS);
    expect(b!.label.endsWith("…")).toBe(true);
  });
});

describe("rowProgressPercent", () => {
  it("maps 0–1 to a percent with one decimal", () => {
    expect(rowProgressPercent(0.4237)).toBe(42.4);
    expect(rowProgressPercent(0)).toBe(0);
    expect(rowProgressPercent(1)).toBe(100);
  });
  it("clamps out-of-range values", () => {
    expect(rowProgressPercent(1.7)).toBe(100);
    expect(rowProgressPercent(-0.2)).toBe(0);
  });
  it("draws no bar for anything that isn't a finite number — never 0% for unknown", () => {
    expect(rowProgressPercent(null)).toBeNull();
    expect(rowProgressPercent(undefined)).toBeNull();
    expect(rowProgressPercent(Number.NaN)).toBeNull();
    expect(rowProgressPercent(Infinity)).toBeNull();
    expect(rowProgressPercent("0.5")).toBeNull();
  });
});

describe("rowProgress", () => {
  it("passes a figure through as determinate", () => {
    expect(rowProgress(0.5)).toEqual({ kind: "determinate", percent: 50 });
  });
  it("reads \"indeterminate\" as the sweep", () => {
    expect(rowProgress("indeterminate")).toEqual({ kind: "indeterminate" });
  });
  it("draws nothing for anything else", () => {
    expect(rowProgress(null)).toBeNull();
    expect(rowProgress("busy")).toBeNull();
    expect(rowProgress(Number.NaN)).toBeNull();
  });
});

function renderList(items: TrackRowItem[], selectable: boolean) {
  const data = { type: "track-row-list", selectable, items } as PluginViewData;
  return render(<PluginViewRenderer pluginName="Soulseek" data={data} currentTrack={null} onAction={vi.fn()} />);
}

describe("track-row-list badge + progress", () => {
  const items: TrackRowItem[] = [
    { id: "a", title: "Moving", subtitle: "61% · 14 of 23 MB", badge: { label: "Downloading", variant: "accent" }, progress: 0.61 },
    { id: "b", title: "Waiting", subtitle: "position 37", badge: { label: "Waiting", variant: "warning" } },
    { id: "c", title: "Plain", subtitle: "nothing extra" },
  ];

  for (const selectable of [true, false]) {
    it(`renders the chip before the subtitle and the bar under it (${selectable ? "selectable" : "plain"} list)`, () => {
      const { container } = renderList(items, selectable);
      const rows = container.querySelectorAll(".ptr-row");
      expect(rows).toHaveLength(3);

      const chip = rows[0].querySelector(".ptr-badge")!;
      expect(chip.textContent).toBe("Downloading");
      expect(chip.className).toContain("ptr-badge--accent");
      expect(chip.parentElement!.textContent).toBe("Downloading61% · 14 of 23 MB");
      const bar = rows[0].querySelector('[role="progressbar"]')!;
      expect(bar.getAttribute("aria-valuenow")).toBe("61");
      expect((bar.querySelector(".ptr-progress-fill") as HTMLElement).style.width).toBe("61%");

      expect(rows[1].querySelector(".ptr-badge--warning")!.textContent).toBe("Waiting");
      expect(rows[1].querySelector('[role="progressbar"]')).toBeNull();

      expect(rows[2].querySelector(".ptr-badge")).toBeNull();
      expect(rows[2].querySelector('[role="progressbar"]')).toBeNull();
    });
  }

  it("a badge alone still gets a secondary line", () => {
    const { container } = renderList([{ id: "x", title: "T", badge: { label: "Failed", variant: "error" } }], true);
    expect(container.querySelector(".ptr-badge--error")!.textContent).toBe("Failed");
  });

  it("draws a pulsing chip and an indeterminate sweep", () => {
    const { container } = renderList([
      { id: "s", title: "Searching", subtitle: "Searching Soulseek", badge: { label: "Searching", variant: "accent", pulse: true }, progress: "indeterminate" },
    ], true);
    const chip = container.querySelector(".ptr-badge")!;
    expect(chip.className).toContain("ptr-badge--pulse");
    expect(chip.querySelector(".ptr-badge-dot")).not.toBeNull();
    expect(chip.textContent).toBe("Searching");
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.className).toContain("ptr-progress--indeterminate");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.querySelector(".ptr-progress-fill")!.className).toContain("ds-motion-essential");
  });
});
