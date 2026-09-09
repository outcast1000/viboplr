import { describe, it, expect } from "vitest";
import { isTextEntryTarget } from "../utils/textEntry";

// Real elements rather than tagName stubs: the predicate reads `.type` and
// `.isContentEditable`, both of which are resolved properties the DOM computes
// (an absent type attribute normalizes to "text", contenteditable="false"
// resolves to false) — a hand-rolled stub would assert the wrong contract.
function input(type?: string): HTMLInputElement {
  const el = document.createElement("input");
  if (type !== undefined) el.setAttribute("type", type);
  return el;
}

describe("isTextEntryTarget", () => {
  it("treats text-ish inputs as typing", () => {
    for (const type of [undefined, "text", "search", "url", "email", "tel", "password", "number", "date"]) {
      expect(isTextEntryTarget(input(type)), `type=${type}`).toBe(true);
    }
  });

  it("treats a textarea as typing", () => {
    expect(isTextEntryTarget(document.createElement("textarea"))).toBe(true);
  });

  // The regression this predicate exists for: clicking the volume slider left
  // focus on it, and a tagName check reported "typing", so the arrow keys went
  // dead app-wide until the user clicked elsewhere.
  it("does not treat control inputs as typing", () => {
    for (const type of ["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image"]) {
      expect(isTextEntryTarget(input(type)), `type=${type}`).toBe(false);
    }
  });

  it("does not treat a select, button or plain element as typing", () => {
    expect(isTextEntryTarget(document.createElement("select"))).toBe(false);
    expect(isTextEntryTarget(document.createElement("button"))).toBe(false);
    expect(isTextEntryTarget(document.createElement("div"))).toBe(false);
  });

  it("resolves contenteditable rather than trusting the attribute", () => {
    const on = document.createElement("div");
    on.setAttribute("contenteditable", "true");
    expect(isTextEntryTarget(on)).toBe(true);

    const off = document.createElement("div");
    off.setAttribute("contenteditable", "false");
    expect(isTextEntryTarget(off)).toBe(false);
  });

  it("finds the editable host from a node inside it", () => {
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    host.appendChild(inner);
    document.body.appendChild(host);
    expect(isTextEntryTarget(inner)).toBe(true);
    host.remove();
  });

  it("survives a null or non-element target", () => {
    expect(isTextEntryTarget(null)).toBe(false);
    expect(isTextEntryTarget(window as unknown as EventTarget)).toBe(false);
  });
});
