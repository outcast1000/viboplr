import { describe, it, expect } from "vitest";
import {
  resolveUpdateNotice,
  dismissNotice,
  appNoticeSignature,
  extensionsNoticeSignature,
  type UpdateNoticeDismissals,
} from "../utils/updateNotice";
import type { ExtensionUpdate } from "../types/plugin";

function ext(over: Partial<ExtensionUpdate> = {}): ExtensionUpdate {
  return {
    id: "ytdlp",
    kind: "plugin",
    name: "yt-dlp",
    currentVersion: "1.7.0",
    latestVersion: "1.8.0",
    changelog: "",
    downloadUrl: "https://example.com/x.zip",
    status: "available",
    ...over,
  };
}

const NO_DISMISSALS: UpdateNoticeDismissals = {};

describe("resolveUpdateNotice", () => {
  it("returns nothing when there is nothing to announce", () => {
    expect(resolveUpdateNotice({
      appUpdate: null, extensionUpdates: [], dismissed: NO_DISMISSALS,
    })).toBeNull();
  });

  it("announces an app update with its release notes", () => {
    const notice = resolveUpdateNotice({
      appUpdate: { version: "1.0.57", body: "- Album artist support" },
      extensionUpdates: [],
      dismissed: NO_DISMISSALS,
    });
    expect(notice).toMatchObject({
      kind: "app",
      title: "Viboplr 1.0.57 is available",
      body: "- Album artist support",
    });
  });

  /** Empty notes must not become an empty "What's new" expander. */
  it("drops empty release notes rather than offering a blank expander", () => {
    const notice = resolveUpdateNotice({
      appUpdate: { version: "1.0.57", body: "" },
      extensionUpdates: [],
      dismissed: NO_DISMISSALS,
    });
    expect(notice?.body).toBeUndefined();
  });

  /**
   * One banner at a time. An extension update can be *gated* on the app one
   * (`requires_app_update`), and two stacked strips would push the view down
   * twice for a single errand.
   */
  it("ranks the app update ahead of extension updates", () => {
    const notice = resolveUpdateNotice({
      appUpdate: { version: "1.0.57", body: "" },
      extensionUpdates: [ext()],
      dismissed: NO_DISMISSALS,
    });
    expect(notice?.kind).toBe("app");
  });

  /** They're separate errands, so silencing one must not silence the other. */
  it("falls through to extensions once the app notice is dismissed", () => {
    const notice = resolveUpdateNotice({
      appUpdate: { version: "1.0.57", body: "" },
      extensionUpdates: [ext()],
      dismissed: { app: appNoticeSignature("1.0.57") },
    });
    expect(notice).toMatchObject({ kind: "extensions", names: ["yt-dlp"] });
  });

  it("names the single extension, and counts several", () => {
    const one = resolveUpdateNotice({
      appUpdate: null, extensionUpdates: [ext()], dismissed: NO_DISMISSALS,
    });
    expect(one?.title).toBe("An update is available for yt-dlp");

    const many = resolveUpdateNotice({
      appUpdate: null,
      extensionUpdates: [ext(), ext({ id: "genius", name: "Genius" })],
      dismissed: NO_DISMISSALS,
    });
    expect(many?.title).toBe("2 extension updates are available");
  });

  /**
   * `requires_app_update` is blocked behind the app update, so announcing it
   * would offer an "Update all" that cannot succeed — the same filter the
   * sidebar's extension badge applies.
   */
  it("ignores extension updates that require a newer app", () => {
    expect(resolveUpdateNotice({
      appUpdate: null,
      extensionUpdates: [ext({ status: "requires_app_update" })],
      dismissed: NO_DISMISSALS,
    })).toBeNull();
  });

  it("stays dismissed for the version that was dismissed", () => {
    const dismissed = { app: appNoticeSignature("1.0.57") };
    expect(resolveUpdateNotice({
      appUpdate: { version: "1.0.57", body: "" }, extensionUpdates: [], dismissed,
    })).toBeNull();
  });

  /** The whole point of keying dismissal by signature: the NEXT release must
   *  announce itself, or the banner is a thing you turn off once forever. */
  it("announces the next release even after a dismissal", () => {
    const notice = resolveUpdateNotice({
      appUpdate: { version: "1.0.58", body: "" },
      extensionUpdates: [],
      dismissed: { app: appNoticeSignature("1.0.57") },
    });
    expect(notice?.title).toBe("Viboplr 1.0.58 is available");
  });

  /** Dismissing "2 updates" must not silence a third that turns up later —
   *  which is exactly what a count-based key would have done. */
  it("re-announces when a further extension update appears", () => {
    const first = [ext()];
    const dismissed = { extensions: extensionsNoticeSignature(first) };
    expect(resolveUpdateNotice({
      appUpdate: null, extensionUpdates: first, dismissed,
    })).toBeNull();
    expect(resolveUpdateNotice({
      appUpdate: null,
      extensionUpdates: [...first, ext({ id: "genius", name: "Genius" })],
      dismissed,
    })).not.toBeNull();
  });

  /** ...and a new version of the SAME extension is a new announcement too. */
  it("re-announces when an already-pending extension gets a newer version", () => {
    const dismissed = { extensions: extensionsNoticeSignature([ext()]) };
    expect(resolveUpdateNotice({
      appUpdate: null,
      extensionUpdates: [ext({ latestVersion: "1.9.0" })],
      dismissed,
    })).not.toBeNull();
  });
});

describe("extensionsNoticeSignature", () => {
  /** The backend fans its checks out across threads, so report order is not
   *  stable — an order-sensitive signature would spontaneously un-dismiss. */
  it("does not depend on the order the updates were reported in", () => {
    const a = ext();
    const b = ext({ id: "genius", name: "Genius", latestVersion: "2.0.0" });
    expect(extensionsNoticeSignature([a, b])).toBe(extensionsNoticeSignature([b, a]));
  });

  it("excludes updates that require a newer app", () => {
    expect(extensionsNoticeSignature([ext({ status: "requires_app_update" })]))
      .toBe(extensionsNoticeSignature([]));
  });
});

describe("dismissNotice", () => {
  it("records the dismissal per kind, leaving the other kind alone", () => {
    const notice = resolveUpdateNotice({
      appUpdate: { version: "1.0.57", body: "" },
      extensionUpdates: [],
      dismissed: { extensions: "ext:ytdlp@1.8.0" },
    })!;
    expect(dismissNotice({ extensions: "ext:ytdlp@1.8.0" }, notice)).toEqual({
      extensions: "ext:ytdlp@1.8.0",
      app: "app:1.0.57",
    });
  });

  /** Same identity back on a repeat, so the persist effect behind this state
   *  doesn't write the store again. */
  it("returns the previous object when nothing changed", () => {
    const notice = resolveUpdateNotice({
      appUpdate: { version: "1.0.57", body: "" },
      extensionUpdates: [],
      dismissed: NO_DISMISSALS,
    })!;
    const dismissed = dismissNotice(NO_DISMISSALS, notice);
    expect(dismissNotice(dismissed, notice)).toBe(dismissed);
  });
});
