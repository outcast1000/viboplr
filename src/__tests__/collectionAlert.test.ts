import { describe, it, expect } from "vitest";
import { collectionAlert } from "../utils/collectionAlert";
import type { Collection } from "../types";

function collection(over: Partial<Collection> = {}): Collection {
  return {
    id: 1,
    kind: "subsonic",
    name: "Navidrome",
    path: null,
    url: "https://music.example.com",
    username: "alex",
    last_synced_at: null,
    auto_update: true,
    auto_update_interval_mins: 1440,
    enabled: true,
    last_sync_duration_secs: null,
    last_sync_error: null,
    ...over,
  };
}

describe("collectionAlert", () => {
  it("is silent when nothing failed", () => {
    expect(collectionAlert([collection(), collection({ id: 2, kind: "local" })])).toBeNull();
  });

  it("is silent for an empty list", () => {
    expect(collectionAlert([])).toBeNull();
  });

  it("names the collection when exactly one failed", () => {
    const label = collectionAlert([
      collection({ name: "Navidrome", last_sync_error: "connection refused" }),
      collection({ id: 2, kind: "local", name: "Music" }),
    ]);
    expect(label).toBe("Navidrome couldn't sync");
  });

  it("counts them when several failed", () => {
    const label = collectionAlert([
      collection({ id: 1, name: "Navidrome", last_sync_error: "connection refused" }),
      collection({ id: 2, name: "Subsonic", last_sync_error: "401" }),
    ]);
    expect(label).toBe("2 collections couldn't sync");
  });

  it("ignores a disabled collection's stale error", () => {
    // A disabled collection isn't syncing, so its error is history, not news —
    // and no action the user takes in Collections would clear the dot.
    expect(
      collectionAlert([collection({ enabled: false, last_sync_error: "connection refused" })]),
    ).toBeNull();
  });

  it("does not let a disabled failure inflate the count", () => {
    const label = collectionAlert([
      collection({ id: 1, name: "Navidrome", last_sync_error: "connection refused" }),
      collection({ id: 2, name: "Old server", enabled: false, last_sync_error: "410" }),
    ]);
    expect(label).toBe("Navidrome couldn't sync");
  });

  it("treats an empty-string error as no error", () => {
    expect(collectionAlert([collection({ last_sync_error: "" })])).toBeNull();
  });
});
