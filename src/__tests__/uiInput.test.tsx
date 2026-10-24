import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import {
  accessibleName,
  clickTarget,
  findTargets,
  pressKeys,
  queryTargets,
  resolveTarget,
  typeIntoTarget,
} from "../utils/uiInput";
import { parseKeyCombo } from "../utils/uiControl";

/**
 * The DOM half of the control API's generic input. jsdom has no layout and no
 * hit-testing, which the resolver is written to tolerate — so these assert
 * the naming, the protection rules and that React really sees the events.
 */

const NO_CURSOR = { cursor: false };

afterEach(() => cleanup());

function Editor({ onSave }: { onSave: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div>
      <div className="label">Album artist</div>
      <input aria-label="Album artist" value={value} onChange={(e) => setValue(e.target.value)} />
      <label>Year <input type="number" /></label>
      <button onClick={() => onSave(value)}>Save Changes</button>
      <button disabled>Disabled one</button>
      <button aria-hidden="true">Hidden</button>
      <button>Twice</button>
      <button>Twice</button>
      <button data-testid="icon-only"><svg /></button>
      <div data-ui-input-protected="">
        <button>Allow and enable</button>
      </div>
    </div>
  );
}

describe("accessible names", () => {
  it("reads aria-label, a wrapping label, and text, in that order", () => {
    render(<Editor onSave={() => {}} />);
    expect(findTargets(document, { role: "field", name: "album ARTIST" })).toHaveLength(1);
    expect(findTargets(document, { role: "field", name: "Year" })).toHaveLength(1);
    expect(accessibleName(resolveTarget(document, { role: "button", name: "Save Changes" }))).toBe("Save Changes");
  });

  it("skips hidden elements and finds unnamed ones by test id", () => {
    render(<Editor onSave={() => {}} />);
    expect(findTargets(document, { role: "button", name: "Hidden" })).toHaveLength(0);
    expect(resolveTarget(document, { role: "any", testId: "icon-only" }).tagName).toBe("BUTTON");
  });

  it("asks for an index when a name is ambiguous, and honours one", () => {
    render(<Editor onSave={() => {}} />);
    expect(() => resolveTarget(document, { role: "button", name: "Twice" })).toThrow(/2 visible matches.*index/);
    const buttons = findTargets(document, { role: "button", name: "Twice" });
    expect(resolveTarget(document, { role: "button", name: "Twice", index: 1 })).toBe(buttons[1]);
    expect(() => resolveTarget(document, { role: "button", name: "Nope" })).toThrow(/ui\/query/);
  });
});

describe("click and type", () => {
  it("types through React's onChange and clicks the real handler", async () => {
    const onSave = vi.fn();
    render(<Editor onSave={onSave} />);
    await act(async () => {
      await typeIntoTarget(document, { role: "field", name: "Album artist" }, "Various Artists",
        { replace: true, charMs: 0, moveMs: 0 }, NO_CURSOR);
    });
    expect((resolveTarget(document, { role: "field", name: "Album artist" }) as HTMLInputElement).value).toBe("Various Artists");
    await act(async () => {
      await clickTarget(document, { role: "button", name: "Save Changes" }, 0, NO_CURSOR);
    });
    expect(onSave).toHaveBeenCalledWith("Various Artists");
  });

  it("refuses disabled targets, non-fields and protected regions", async () => {
    render(<Editor onSave={() => {}} />);
    await expect(clickTarget(document, { role: "button", name: "Disabled one" }, 0, NO_CURSOR)).rejects.toThrow(/disabled/);
    await expect(typeIntoTarget(document, { role: "button", name: "Save Changes" }, "x",
      { replace: false, charMs: 0, moveMs: 0 }, NO_CURSOR)).rejects.toThrow(/not a text field/);
    await expect(clickTarget(document, { role: "button", name: "Allow and enable" }, 0, NO_CURSOR))
      .rejects.toThrow(/only the user may operate/);
  });

  it("marks protected matches in a query instead of hiding them", () => {
    render(<Editor onSave={() => {}} />);
    const result = queryTargets(document, { role: "button" }, 50);
    const allow = result.matches.find((m) => m.name === "Allow and enable");
    expect(allow?.protected).toBe(true);
    expect(result.matches.find((m) => m.name === "Save Changes")?.protected).toBe(false);
    expect(result.viewport.devicePixelRatio).toBeGreaterThan(0);
  });
});

describe("keys", () => {
  it("delivers a chord to the focused element", () => {
    render(<Editor onSave={() => {}} />);
    const seen: string[] = [];
    window.addEventListener("keydown", (e) => seen.push(`${e.metaKey ? "Meta+" : ""}${e.key}`), { once: true });
    pressKeys(document, parseKeyCombo("Mod+K", true));
    expect(seen).toEqual(["Meta+k"]);
  });

  it("refuses a key while focus is inside a protected region", () => {
    render(<Editor onSave={() => {}} />);
    (resolveTarget(document, { role: "button", name: "Allow and enable" }) as HTMLButtonElement).focus();
    expect(() => pressKeys(document, parseKeyCombo("Enter", true))).toThrow(/only the user may operate/);
  });
});
