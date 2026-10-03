/**
 * Remote handles for UI state that lives *inside* a component rather than in
 * App — today only the equalizer popover, whose open flag `AudioOptionsGroup`
 * owns (it is rendered by both playback bars, each with its own popover).
 *
 * The control API's `ui.action { action: "eqPanel" }` needs to open it, and
 * lifting the flag into App would mean threading it through both bars for one
 * automation verb. Instead each mounted group registers itself here under the
 * bar it belongs to, and the dispatcher addresses the bar that is actually on
 * screen. A group that isn't mounted simply isn't registered.
 */

export type EqHost = "bar" | "fullscreen";

interface EqHandle {
  isOpen: () => boolean;
  setOpen: (open: boolean) => void;
}

const eqHandles = new Map<EqHost, EqHandle>();

/** Register a bar's EQ popover. Returns the unregister function (an effect
 *  cleanup). A later registration for the same host replaces the earlier one. */
export function registerEqPanel(host: EqHost, handle: EqHandle): () => void {
  eqHandles.set(host, handle);
  return () => {
    if (eqHandles.get(host) === handle) eqHandles.delete(host);
  };
}

/** Open or close the popover on `host`. False when that bar has no group
 *  mounted (e.g. asking the fullscreen bar while not fullscreen). */
export function setEqPanelOpen(host: EqHost, open: boolean): boolean {
  const handle = eqHandles.get(host);
  if (!handle) return false;
  handle.setOpen(open);
  return true;
}

export function isEqPanelOpen(host: EqHost): boolean {
  return eqHandles.get(host)?.isOpen() ?? false;
}
