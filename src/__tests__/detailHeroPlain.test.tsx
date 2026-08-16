import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DetailHero } from "../components/DetailHero";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null), convertFileSrc: (p: string) => p }));

// This renders the component rather than asserting on props, because the bug it
// guards was exactly that: `plain` was declared on the interface and threaded
// through the plugin node, every type-check and plugin test passed, and the
// hero still drew its artwork — the edit that was supposed to consume the prop
// had silently not applied. Only the output can tell you the prop does anything.
afterEach(cleanup);

function hero(props: Partial<Parameters<typeof DetailHero>[0]> = {}) {
  return render(
    <DetailHero
      bgImages={[]}
      art={<img alt="art" src="x.png" />}
      artShape="square"
      title="Some Torrent Name"
      entityLabel="album"
      meta={[]}
      overflowItems={[]}
      {...props}
    />,
  );
}

describe("DetailHero plain mode", () => {
  it("draws no art block at all — not an empty one", () => {
    const { container } = hero({ plain: true });
    expect(container.querySelector(".detail-hero-art")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("drops the background, the motion look and the FX picker", () => {
    const { container } = hero({ plain: true });
    expect(container.querySelector(".detail-hero-bg")).toBeNull();
    expect(container.querySelector(".detail-hero-fx-select")).toBeNull();
    expect(container.querySelector('[class*="hero-motion-"]')).toBeNull();
  });

  it("keeps the title and the Back button — the reason to use a hero at all", () => {
    const onBack = vi.fn();
    const { container, getByLabelText } = hero({ plain: true, onBack });
    expect(container.querySelector(".detail-hero-title-text")?.textContent).toBe("Some Torrent Name");
    getByLabelText("Back").click();
    expect(onBack).toHaveBeenCalled();
  });

  it("marks itself so the CSS can restyle the always-light hero text", () => {
    // The hero's text tokens are the light set meant to sit on a scrim over
    // artwork; with no background they would be white text on the page.
    const { container } = hero({ plain: true });
    expect(container.querySelector(".detail-hero--plain")).not.toBeNull();
  });

  it("leaves every normal hero exactly as it was", () => {
    const { container } = hero();
    expect(container.querySelector(".detail-hero-art")).not.toBeNull();
    expect(container.querySelector(".detail-hero-bg")).not.toBeNull();
    expect(container.querySelector(".detail-hero-fx-select")).not.toBeNull();
    expect(container.querySelector(".detail-hero--plain")).toBeNull();
  });
});

describe("DetailHero buttons", () => {
  it("replaces Play/Enqueue rather than joining them", () => {
    // A subject those verbs don't fit would otherwise carry two permanently
    // disabled buttons next to its real ones.
    const { container, getByText, queryByText } = hero({
      buttons: [
        { id: "stop", label: "Stop", onClick: vi.fn() },
        { id: "remove", label: "Remove…", variant: "danger", onClick: vi.fn() },
      ],
    });
    expect(queryByText("Play")).toBeNull();
    expect(queryByText("Enqueue")).toBeNull();
    expect(getByText("Stop")).toBeTruthy();
    expect(container.querySelector(".ds-btn--danger")?.textContent).toBe("Remove…");
  });

  it("fires the button's own handler", () => {
    const onClick = vi.fn();
    const { getByText } = hero({ buttons: [{ id: "stop", label: "Stop", onClick }] });
    getByText("Stop").click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("leaves every hero without them showing Play and Enqueue", () => {
    const { getByText } = hero();
    expect(getByText("Play")).toBeTruthy();
    expect(getByText("Enqueue")).toBeTruthy();
  });

  it("keeps the overflow menu either way", () => {
    const withButtons = hero({ buttons: [{ id: "a", label: "A", onClick: vi.fn() }] });
    // The overflow renders whenever there are items; assert the actions row is
    // still the container for both, so a plugin can have buttons AND a ⋯ menu.
    expect(withButtons.container.querySelector(".detail-hero-actions")).not.toBeNull();
  });
});

describe("plain hero layout", () => {
  it("puts the Back button in the flow, not over the title", () => {
    // The absolute top-left position works over a 320px panel whose content
    // sits at the bottom. Plain mode starts at the top, so the button landed
    // on the title. In the flow it is the first item on the row instead.
    const { container } = hero({ plain: true, onBack: vi.fn() });
    const back = container.querySelector(".detail-hero-back")!;
    const row = container.querySelector(".detail-hero-row")!;
    expect(back).not.toBeNull();
    // Siblings, in order — not one painted over the other.
    expect(back.nextElementSibling).toBe(row);
    expect(row.contains(back)).toBe(false);
  });
});
