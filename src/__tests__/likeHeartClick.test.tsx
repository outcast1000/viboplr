// The heart's click is a plain like toggle — un-liking must never dislike.
// Dislike is reached through the heart's right-click menu (buildRatingMenuSpecs)
// or Cmd/Ctrl+Shift+L, never by clicking through the states.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const showNativeMenu = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("../nativeMenu", () => ({ showNativeMenu: (...a: unknown[]) => showNativeMenu(...a) }));

import { LikeDislikeButtons } from "../components/LikeDislikeButtons";
import { buildRatingMenuSpecs } from "../contextMenu/ratingMenu";
import type { MenuItemSpec } from "../nativeMenu";

afterEach(() => { cleanup(); showNativeMenu.mockClear(); });

function heart(liked: number, withDislike = true) {
  const onToggleLike = vi.fn();
  const onToggleDislike = vi.fn();
  render(
    <LikeDislikeButtons
      liked={liked}
      entityLabel="song"
      onToggleLike={onToggleLike}
      onToggleDislike={withDislike ? onToggleDislike : undefined}
    />,
  );
  return { btn: screen.getByRole("button"), onToggleLike, onToggleDislike };
}

describe("heart click", () => {
  it("likes a neutral song", () => {
    const h = heart(0);
    fireEvent.click(h.btn);
    expect(h.onToggleLike).toHaveBeenCalledTimes(1);
    expect(h.onToggleDislike).not.toHaveBeenCalled();
  });

  it("un-likes a liked song instead of disliking it", () => {
    const h = heart(1);
    fireEvent.click(h.btn);
    expect(h.onToggleLike).toHaveBeenCalledTimes(1);
    expect(h.onToggleDislike).not.toHaveBeenCalled();
  });

  it("clears a disliked song (the dislike toggle turns it off)", () => {
    const h = heart(-1);
    fireEvent.click(h.btn);
    expect(h.onToggleDislike).toHaveBeenCalledTimes(1);
    expect(h.onToggleLike).not.toHaveBeenCalled();
  });

  it("tooltips say what the next click does", () => {
    expect(heart(0).btn.title).toBe("Like song\nRight-click to dislike");
    cleanup();
    expect(heart(1).btn.title).toBe("Liked song\nClick to remove · right-click for more");
    cleanup();
    expect(heart(-1).btn.title).toBe("Disliked song\nKept out of radio and mixes · click to clear");
  });
});

describe("heart right-click", () => {
  it("opens the rating menu at the pointer and keeps the surface's menu out", () => {
    const onRowMenu = vi.fn();
    render(
      <div onContextMenu={onRowMenu}>
        <LikeDislikeButtons liked={1} entityLabel="song" onToggleLike={() => {}} onToggleDislike={() => {}} />
      </div>,
    );
    fireEvent.contextMenu(screen.getByRole("button"), { clientX: 40, clientY: 60 });
    expect(showNativeMenu).toHaveBeenCalledTimes(1);
    const [x, y, specs] = showNativeMenu.mock.calls[0] as [number, number, MenuItemSpec[]];
    expect([x, y]).toEqual([40, 60]);
    expect(specs.map((s) => ("text" in s ? s.text : s.kind))).toEqual(["Like", "No rating", "Dislike"]);
    expect(onRowMenu).not.toHaveBeenCalled();
  });

  it("without a dislike callback, leaves the right-click to the surface", () => {
    const h = heart(0, false);
    fireEvent.contextMenu(h.btn);
    expect(showNativeMenu).not.toHaveBeenCalled();
  });
});

describe("buildRatingMenuSpecs", () => {
  type Check = Extract<MenuItemSpec, { kind: "check" }>;
  function specs(rating: number) {
    const like = vi.fn();
    const dislike = vi.fn();
    const items = buildRatingMenuSpecs(rating, { like, dislike }) as Check[];
    return { items, like, dislike, byText: (t: string) => items.find((i) => i.text === t)! };
  }

  it("checks the current state; No rating is disabled when there is none", () => {
    expect(specs(1).items.map((i) => i.checked)).toEqual([true, false, false]);
    expect(specs(-1).items.map((i) => i.checked)).toEqual([false, false, true]);
    const n = specs(0);
    expect(n.items.map((i) => i.checked)).toEqual([false, true, false]);
    expect(n.byText("No rating").enabled).toBe(false);
  });

  it("Like and Dislike are the canonical toggles", () => {
    const s = specs(1);
    s.byText("Like").action();
    s.byText("Dislike").action();
    expect(s.like).toHaveBeenCalledTimes(1);
    expect(s.dislike).toHaveBeenCalledTimes(1);
  });

  it("No rating toggles off whichever state is set", () => {
    const liked = specs(1);
    liked.byText("No rating").action();
    expect(liked.like).toHaveBeenCalledTimes(1);
    expect(liked.dislike).not.toHaveBeenCalled();
    const disliked = specs(-1);
    disliked.byText("No rating").action();
    expect(disliked.dislike).toHaveBeenCalledTimes(1);
    expect(disliked.like).not.toHaveBeenCalled();
  });
});
