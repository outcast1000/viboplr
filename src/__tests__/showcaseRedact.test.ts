import { afterEach, describe, expect, it } from "vitest";
import { compileRules, redactText, startRedaction } from "../utils/showcaseRedact";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("redactText", () => {
  it("replaces every occurrence, case-insensitively, longest rule first", () => {
    const rules = compileRules([
      { text: "outcast", replacement: "•••" },
      { text: "outcast1000", replacement: "you" },
    ]);
    expect(redactText("Signed in as OUTCAST1000 · outcast1000", rules)).toBe("Signed in as you · you");
    expect(redactText("an outcast", rules)).toBe("an •••");
  });

  it("treats rule text literally, not as a pattern", () => {
    expect(redactText("a.b and axb", compileRules([{ text: "a.b", replacement: "-" }]))).toBe("- and axb");
  });
});

describe("startRedaction", () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
    document.body.innerHTML = "";
  });

  it("redacts what is there, what is added later, and text rewritten in place", async () => {
    document.body.innerHTML = "<p id='a'>Signed in as outcast1000</p>";
    stop = startRedaction(document.body, [{ text: "outcast1000", replacement: "you" }]);
    expect(document.getElementById("a")!.textContent).toBe("Signed in as you");

    const added = document.createElement("span");
    added.textContent = "outcast1000's mix";
    document.body.appendChild(added);
    await flush();
    expect(added.textContent).toBe("you's mix");

    // React updates a text node in place.
    (document.getElementById("a")!.firstChild as Text).nodeValue = "Hi outcast1000";
    await flush();
    expect(document.getElementById("a")!.textContent).toBe("Hi you");
  });

  it("puts the original text back on stop", async () => {
    document.body.innerHTML = "<p id='a'>Signed in as outcast1000</p>";
    const end = startRedaction(document.body, [{ text: "outcast1000", replacement: "you" }]);
    end();
    expect(document.getElementById("a")!.textContent).toBe("Signed in as outcast1000");
  });

  it("is a no-op without rules", () => {
    document.body.innerHTML = "<p id='a'>outcast1000</p>";
    stop = startRedaction(document.body, []);
    expect(document.getElementById("a")!.textContent).toBe("outcast1000");
  });
});
