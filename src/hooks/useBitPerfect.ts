import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nativeEngine } from "../playback/nativeEngine";
import { subscribe } from "../utils/tauriEvents";
import { useLatestRef } from "./useLatestRef";
import {
  describeBitPerfectState,
  isOutputSettling,
  resolveBitPerfectState,
  BIT_PERFECT_SETTLE_MS,
  BIT_PERFECT_VOLUME_REASON,
  bitPerfectDeviceVolumeNote,
  handoverDeviceVolume,
  type BitPerfectState,
  type DevicePin,
  type EngineOutput,
} from "../utils/bitPerfect";
import type { BitPerfectControl } from "../components/BitPerfectButton";

/** Off-state tooltip: what the mode is for, and that it's an uncompromising one. */
const BIT_PERFECT_OFF_TEXT =
  "Bit-perfect — the audiophile's no-compromise mode for maximum audio quality. " +
  "Sends each file to your DAC exactly as stored: exclusive device access, no EQ or volume processing, native sample rate.";

/** Minimum gap between "volume is fixed" hints, so a wheel spin raises one toast. */
const VOLUME_HINT_INTERVAL_MS = 4000;

/** After a local device-volume change, ignore the watchdog's device volume for
 *  this long: it polls once a second, and a report taken mid-drag would snap
 *  the slider back to an older value. */
const DEVICE_VOLUME_ECHO_MS = 1500;

interface UseBitPerfectOptions {
  /** Native engine selected + loadable, on macOS. Off → the toggle is hidden
   *  and an active mode turns itself off. */
  available: boolean;
  playing: boolean;
  /** Key of the track the frontend considers current. */
  currentKey: string | null;
  /** The player's own volume (0..1) — what the device is lowered by at enable. */
  appVolume: number;
  /** The user ticked "Don't ask again" on the confirmation (persisted). */
  skipConfirm: boolean;
  setSkipConfirm: (skip: boolean) => void;
  notify: (message: string) => void;
  /** Called after every toggle so the next track is re-armed under the new
   *  output (usePlayback.invalidatePreload). */
  onOutputChanged: () => void;
}

/**
 * Leaving the native engine must end the mode — App's engine-switch handler
 * calls `disable()` directly (no effect watching `available`).
 *
 * Bit-perfect mode: a session-only overlay (never persisted — every launch
 * starts with it off). The engine does the overlaying (neutral DSP, pinned
 * device, exclusive, full volume — see mpv_engine/output.rs); this hook owns
 * the enable/confirm flow, the verified state from `engine-output`, and the
 * reactions to it (device unplugged → off).
 */
export function useBitPerfect(opts: UseBitPerfectOptions) {
  const { available, playing, currentKey, skipConfirm, setSkipConfirm } = opts;
  // Callbacks via latest-refs: App passes fresh closures every render, and the
  // `control` object must stay identity-stable for the memo'd playback bar.
  const notifyRef = useLatestRef(opts.notify);
  const onOutputChangedRef = useLatestRef(opts.onOutputChanged);
  const appVolumeRef = useLatestRef(opts.appVolume);
  const notify = useCallback((message: string) => notifyRef.current(message), [notifyRef]);
  const [pin, setPin] = useState<DevicePin | null>(null);
  const [output, setOutput] = useState<EngineOutput | null>(null);
  /** The device the confirmation modal is asking about (null = modal closed). */
  const [confirmPin, setConfirmPin] = useState<DevicePin | null>(null);
  const lastHintRef = useRef(0);
  const pinRef = useLatestRef(pin);
  // The pinned device's own volume while on (null = it has none, so the
  // player's volume stays locked). Optimistic on local changes.
  const [deviceVolume, setDeviceVolume] = useState<number | null>(null);
  const deviceVolumeRef = useLatestRef(deviceVolume);
  /** The device volume before the mode lowered it — put back on disable. */
  const savedDeviceVolumeRef = useRef<number | null>(null);
  const lastLocalVolumeSetRef = useRef(0);
  // Grace window for a reopening output (isOutputSettling). Driven from the
  // event handler and a timer — no effect — so it opens on each settled →
  // unsettled transition (enable, a sample-rate change) and closes on its own.
  const [settling, setSettling] = useState(false);
  const wasSettlingRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endSettling = useCallback(() => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    setSettling(false);
  }, []);

  const apply = useCallback(async (next: DevicePin | null) => {
    const prev = pinRef.current;
    try {
      if (next) {
        // Hand the level over *before* the engine goes to full digital scale:
        // lower the device by the player's old volume, so loudness drops
        // rather than jumps. Best effort — the confirmation also warns.
        let startVolume: number | null = null;
        savedDeviceVolumeRef.current = null;
        if (next.hasVolume) {
          try {
            const current = await nativeEngine.deviceVolume(next.uid);
            savedDeviceVolumeRef.current = current;
            startVolume = current;
            const lowered = handoverDeviceVolume(current, appVolumeRef.current);
            if (lowered !== null) {
              await nativeEngine.setDeviceVolume(next.uid, lowered);
              startVolume = lowered;
            }
          } catch (e) {
            console.error("Failed to hand the volume over to the device:", e);
          }
        }
        await nativeEngine.setBitPerfect(next);
        setDeviceVolume(startVolume);
      } else {
        // Player volume back first, device level second — the other order
        // would briefly raise the device while mpv is still at full scale.
        await nativeEngine.setBitPerfect(null);
        const saved = savedDeviceVolumeRef.current;
        savedDeviceVolumeRef.current = null;
        if (prev && saved !== null) {
          nativeEngine.setDeviceVolume(prev.uid, saved).catch((e) =>
            console.error("Failed to restore the device volume:", e));
        }
        setDeviceVolume(null);
      }
      setPin(next);
      setOutput(null);
      wasSettlingRef.current = false;
      endSettling();
      onOutputChangedRef.current();
    } catch (e) {
      console.error("Failed to switch Bit-perfect mode:", e);
      notify(`Couldn't ${next ? "turn on" : "turn off"} Bit-perfect mode: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [notify, onOutputChangedRef, endSettling, pinRef, appVolumeRef]);

  const disable = useCallback(() => apply(null), [apply]);

  /** Start enabling: resolve the device to pin, then confirm (unless skipped). */
  const requestEnable = useCallback(async () => {
    let device: DevicePin | null = null;
    try {
      device = await nativeEngine.defaultOutputDevice();
    } catch (e) {
      console.error("Failed to read the default output device:", e);
    }
    if (!device) {
      notify("Couldn't find an output device for Bit-perfect mode");
      return;
    }
    if (skipConfirm) await apply(device);
    else setConfirmPin(device);
  }, [apply, notify, skipConfirm]);

  const confirmEnable = useCallback(async (dontAskAgain: boolean) => {
    const device = confirmPin;
    setConfirmPin(null);
    if (dontAskAgain) setSkipConfirm(true);
    if (device) await apply(device);
  }, [apply, confirmPin, setSkipConfirm]);

  const cancelEnable = useCallback(() => setConfirmPin(null), []);

  const toggle = useCallback(() => {
    if (pin) void disable();
    else void requestEnable();
  }, [pin, disable, requestEnable]);

  // Verified output reports, only while on. The engine stops emitting once off.
  useEffect(() => {
    if (!pin) return;
    return subscribe<EngineOutput>("engine-output", ({ payload }) => {
      if (payload.deviceUid !== pin.uid) return; // a report from a superseded pin
      if (!payload.devicePresent) {
        // The pinned device went away (unplugged): the mode can't do its job,
        // and mpv would otherwise sit on a missing device. Off, and say so.
        notify(`${pin.name} disconnected — Bit-perfect mode off`);
        void apply(null);
        return;
      }
      const nowSettling = isOutputSettling(payload);
      if (nowSettling && !wasSettlingRef.current) {
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        setSettling(true);
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null;
          setSettling(false);
        }, BIT_PERFECT_SETTLE_MS);
      } else if (!nowSettling) {
        endSettling();
      }
      wasSettlingRef.current = nowSettling;
      if (Date.now() - lastLocalVolumeSetRef.current > DEVICE_VOLUME_ECHO_MS) {
        setDeviceVolume(payload.deviceVolume);
      }
      setOutput(payload);
    });
  }, [pin, notify, apply, endSettling]);

  const state: BitPerfectState | null = pin ? resolveBitPerfectState(output, { playing, currentKey, settling }) : null;
  const described = state && pin ? describeBitPerfectState(state, pin.name) : null;

  /**
   * usePlayback.volumeOverrideRef target while on: every volume input drives
   * the device's own level (mpv stays at full scale, so the samples stay
   * untouched). A device without one keeps the lock, and this explains why.
   */
  const setVolumeWhileOn = useCallback((level: number) => {
    const p = pinRef.current;
    if (!p) return;
    if (deviceVolumeRef.current === null) {
      const now = Date.now();
      if (now - lastHintRef.current < VOLUME_HINT_INTERVAL_MS) return;
      lastHintRef.current = now;
      notify(BIT_PERFECT_VOLUME_REASON);
      return;
    }
    const clamped = Math.max(0, Math.min(1, level));
    lastLocalVolumeSetRef.current = Date.now();
    setDeviceVolume(clamped);
    nativeEngine.setDeviceVolume(p.uid, clamped).catch((e) =>
      console.error("Failed to set the device volume:", e));
  }, [notify, pinRef, deviceVolumeRef]);

  const control: BitPerfectControl | null = useMemo(() => {
    if (!available) return null;
    return {
      on: pin !== null,
      tone: described?.tone ?? "neutral",
      text: described?.text ?? BIT_PERFECT_OFF_TEXT,
      onToggle: toggle,
      volumeLocked: pin !== null && deviceVolume === null,
      volumeNote: pin !== null && deviceVolume !== null ? bitPerfectDeviceVolumeNote(pin.name) : null,
    };
  }, [available, pin, described?.tone, described?.text, toggle, deviceVolume]);

  return {
    on: pin !== null,
    pin,
    output,
    state,
    control,
    confirmPin,
    confirmEnable,
    cancelEnable,
    disable,
    setVolumeWhileOn,
    /** What the volume controls show while on: the device's level (1 when it
     *  has none — the player is at full scale). Null while off. */
    controlsVolume: pin !== null ? (deviceVolume ?? 1) : null,
  };
}
