// Whether a plugin may run on this app version. A dev-folder plugin is built
// against the unreleased source, so it may declare the version that source will
// ship as — it is never refused for that.
import { describe, it, expect } from "vitest";
import { pluginIncompatibility } from "../utils/pluginStability";

describe("pluginIncompatibility", () => {
  it("refuses an installed plugin that needs a newer app, saying which", () => {
    expect(pluginIncompatibility({ minAppVersion: "1.0.118" }, "1.0.117", false))
      .toBe("Requires app version 1.0.118 (current: 1.0.117)");
  });

  it("runs a dev-folder plugin that needs a newer app", () => {
    expect(pluginIncompatibility({ minAppVersion: "1.0.118" }, "1.0.117", true)).toBeNull();
  });

  it("runs a plugin whose requirement is met, or that declares none", () => {
    expect(pluginIncompatibility({ minAppVersion: "1.0.117" }, "1.0.117", false)).toBeNull();
    expect(pluginIncompatibility({ minAppVersion: "1.0.117" }, "1.0.118-beta.1", false)).toBeNull();
    expect(pluginIncompatibility({}, "1.0.117", false)).toBeNull();
  });
});
