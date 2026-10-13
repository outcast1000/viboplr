import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";

/**
 * The setup wizard's Spotify step polls the plugin's `status` tool. When that
 * tool can't answer — missing, throwing, or replying with a status the mapper
 * doesn't know — the step must still let the user sign in, instead of sitting
 * on a disabled button and "Checking…" for good. And the poll must never have
 * two reads in flight at once.
 */
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ audioDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { SpotifyStep } = await import("../components/OnboardingWizard");

function button(container: HTMLElement): HTMLButtonElement {
  const b = container.querySelector<HTMLButtonElement>(".onboarding-connect button");
  if (!b) throw new Error("no sign-in button");
  return b;
}

function statusText(container: HTMLElement): string {
  return container.querySelector(".onboarding-connect-status")?.textContent ?? "";
}

/** Let the pending read settle (microtasks only — no poll tick). */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SpotifyStep", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    errorSpy.mockRestore();
  });

  it("keeps the button disabled only until the first read answers", async () => {
    let resolve: (v: unknown) => void = () => {};
    const getStatus = vi.fn(() => new Promise((r) => (resolve = r)));
    const { container } = render(<SpotifyStep onSignIn={vi.fn()} getStatus={getStatus} />);
    expect(button(container).disabled).toBe(true);

    resolve({ syncStatus: "idle", playlistCount: 0 });
    await flush();
    expect(button(container).disabled).toBe(false);
    expect(statusText(container)).toContain("Not connected yet");
  });

  it("enables sign-in when the status tool throws, and logs the failure once", async () => {
    const getStatus = vi.fn(() => Promise.reject(new Error('plugin "spotify-browse" registers no tool "status"')));
    const { container } = render(<SpotifyStep onSignIn={vi.fn()} getStatus={getStatus} />);
    await flush();

    expect(button(container).disabled).toBe(false);
    expect(statusText(container)).toContain("Couldn't check whether you're signed in");

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
    }
    expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("enables sign-in when the status is one the mapper doesn't know", async () => {
    const getStatus = vi.fn(() => Promise.resolve({ syncStatus: "something-new" }));
    const onSignIn = vi.fn();
    const { container } = render(<SpotifyStep onSignIn={onSignIn} getStatus={getStatus} />);
    await flush();

    expect(button(container).disabled).toBe(false);
    fireEvent.click(button(container));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    // Sign-in started, but nothing can confirm it: say so, and keep the button live.
    expect(statusText(container)).toContain("can't check whether it worked");
    expect(button(container).disabled).toBe(false);
  });

  it("recovers once the status becomes readable", async () => {
    let fail = true;
    const getStatus = vi.fn(() =>
      fail ? Promise.reject(new Error("not loaded yet")) : Promise.resolve({ syncStatus: "done", playlistCount: 3 }),
    );
    const { container } = render(<SpotifyStep onSignIn={vi.fn()} getStatus={getStatus} />);
    await flush();
    expect(statusText(container)).toContain("Couldn't check");

    fail = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(statusText(container)).toContain("3 playlists ready");
  });

  it("drops the spinner when the tool breaks while it was still checking", async () => {
    let calls = 0;
    const getStatus = vi.fn(() =>
      calls++ === 0 ? Promise.resolve({ syncStatus: "checking" }) : Promise.reject(new Error("plugin reloading")),
    );
    const { container } = render(<SpotifyStep onSignIn={vi.fn()} getStatus={getStatus} />);
    await flush();
    expect(button(container).disabled).toBe(true);
    expect(statusText(container)).toContain("already signed in");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(button(container).disabled).toBe(false);
    expect(statusText(container)).toContain("Couldn't check");
    expect(container.querySelector(".ds-spinner")).toBeNull();
  });

  it("never has two reads in flight, however slow the tool is", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const getStatus = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5000));
      inFlight--;
      return { syncStatus: "waiting-login", playlistCount: 0 };
    });
    render(<SpotifyStep onSignIn={vi.fn()} getStatus={getStatus} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(maxInFlight).toBe(1);
    // 20s of 5s reads plus 1.5s gaps: three or four reads, not the thirteen an interval would start.
    expect(getStatus.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("stops polling on unmount", async () => {
    const getStatus = vi.fn(() => Promise.resolve({ syncStatus: "idle", playlistCount: 0 }));
    const { unmount } = render(<SpotifyStep onSignIn={vi.fn()} getStatus={getStatus} />);
    await flush();
    unmount();
    const calls = getStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(getStatus.mock.calls.length).toBe(calls);
  });
});
