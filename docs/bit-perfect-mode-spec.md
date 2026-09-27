# Bit-perfect mode — spec

Status: **implemented** (brainstorm + live spike 2026-09-27; built 2026-09-28). The implementation moved the overlay **engine-side** and reloads via `ao-reload` — see "Implementation map".

A one-click toggle in the now-playing bar that sends audio to the output device exactly as
decoded from the file: exclusive device access, no DSP, full digital volume, at the source's
sample rate. It builds on what already exists — the `audioExclusive` setting
(`engine_set_audio_exclusive` → mpv `audio-exclusive`), the engine's exclusive→gapless
arming (`mpv_engine/mod.rs`, crossfade is already suspended under exclusive), and the blocker
list in `src/utils/bitPerfect.ts`.

The name is a promise the app can check, so **the badge reports verified state, never
intent**. Most of this spec exists because the spike showed how often intent and reality
diverge.

## Spike findings (what the design is answering)

Measured on macOS with an env-gated probe (`VIBOPLR_AUDIO_PROBE=1`,
`src-tauri/src/mpv_engine/audio_probe.rs`) against MacBook Pro Speakers and a Jabra Link 380.

| # | Finding | Consequence |
|---|---|---|
| 1 | Hog mode takes when the device is free; CoreAudio `kAudioDevicePropertyHogMode` then holds our pid. Other apps go silent. | Hog ownership is directly verifiable. |
| 2 | mpv's exclusive AO switches the device's physical format to the source rate (48k → 44.1k observed). | Rate matching works… |
| 3 | …but only when the AO is reopened. The engine sets `gapless-audio=yes`, which keeps the AO in the **first** track's format and resamples the rest (96k → 44.1k observed, even under exclusive). With `weak`, 44.1k and 96k each played at their own rate. | Bit-perfect mode runs `gapless-audio=weak`. |
| 4 | `audio-device=auto` is unstable under exclusive: macOS moves the system default **away** from a hogged device, so the next AO open follows the default elsewhere (speakers → Jabra, observed). | The device must be pinned: `audio-device=coreaudio/<UID>`. Pinning held across track changes. |
| 5 | When the pinned device is held by another process, mpv only **warns** (`failed to set hogmode`, `!hog`), waits 2s on a format change timeout, still reports `current-ao=coreaudio_exclusive`, and then produces **no sound** while the UI shows "playing" with a frozen position and no error. It resumes by itself the moment the other holder releases. | Busy must be detected and shown. `current-ao` is not a usable signal. |
| 6 | Speed (`engine_set_speed`, `audio-pitch-correction=no`) resamples whenever ≠ 1.0. | Speed is a blocker too — not in the original list. |

## Behaviour

### Enabling

1. Toggle in the now-playing bar (next to the EQ group). Available only when
   `mpvCapable && playbackEngine === "native"` and on macOS (see Platform). Otherwise hidden.
2. Confirmation modal (first time; "Don't ask again" persisted as `confirmBitPerfect`, same
   pattern as `confirmTrashDelete`). Copy:

   > **Bit-perfect playback**
   > Viboplr will send audio to **{device name}** exactly as it's stored in the file:
   > - **Exclusive access** — other apps (browser, calls, system sounds) won't play through
   >   this device until you turn this off.
   > - **Volume fixed at 100%** — control loudness on your DAC or amplifier.
   >   **Turn it down before continuing.**
   > - **EQ, ReplayGain and speed suspended**; crossfade is replaced by gapless playback.
   > - The device follows each track's sample rate; switching rate between tracks can cause a
   >   brief gap.
   >
   > Your settings aren't changed — turning this off restores everything.
   > ☐ Don't ask again   [Cancel] [Enable]

3. On accept:
   - Resolve and **pin the current default output device** (UID + name) — read backend-side
     via CoreAudio at the moment of enabling.
   - Set the session flag `bitPerfectMode = { deviceUid, deviceName }`. **Not persisted** —
     every launch starts with it off, which also means volume returns to the user's saved level.
   - Reload the current track at its current position so the AO reopens exclusive + pinned
     immediately. If playback was paused, stay paused (the device opens on the next play); the
     mode never starts audio by itself.

### While on (overlay — user settings are never written)

The engine receives *effective* values; the stored settings stay untouched:

| Setting | Effective value | UI |
|---|---|---|
| Exclusive | on | Settings row shows "on (Bit-perfect mode)" |
| Output device | pinned UID | shown in badge tooltip |
| gapless-audio | `weak` | — |
| EQ | disabled (empty `af`) | EQ group dimmed, tooltip "Suspended by Bit-perfect" |
| ReplayGain | off | Settings rows show suspended |
| Speed | 1.0 | speed control disabled |
| Crossfade | suspended (engine already does this under exclusive) | Settings slider shows suspended |
| Volume | 1.0 | slider locked at 100%, tooltip "Use your DAC/amp volume" |
| Mute | **allowed** (silence doesn't affect bit-perfection) | normal |

Volume changes from **any** source are ignored while on — the single choke point is
`playback.handleVolume` (slider, wheel, arrow keys, control API all route through it). A
throttled hint toast explains why ("Volume is fixed in Bit-perfect mode — use your DAC").

### Disabling

Clear the flag → effective values revert to the stored settings → reload the current track at
its position (releases the hog, restores `gapless-audio=yes` and the user's volume). No
confirmation.

## Verification and the badge

After every AO (re)open and on a 1s watchdog while the mode is on, the engine evaluates and
emits `engine-output` (new event):

```jsonc
{
  "deviceUid": "BuiltInSpeakerDevice",
  "deviceName": "MacBook Pro Speakers",
  "devicePresent": true,
  "hoggedByUs": true,          // kAudioDevicePropertyHogMode == our pid
  "holderPid": null,           // pid holding it when not us (-1 → null)
  "holderName": null,          // proc name of holderPid, for the "in use by" copy
  "srcRate": 96000,            // audio-params/samplerate
  "outRate": 96000,            // audio-out-params/samplerate
  "deviceRate": 96000,         // nominal rate of the pinned device
  "deviceMaxRate": 96000       // highest available nominal rate
}
```

The frontend folds it with the existing `bitPerfectBlockers()` (extended with `speed`) into
one state:

| State | Condition | Badge |
|---|---|---|
| **Bit-perfect** | hoggedByUs, src = out = device rate, no blockers | green · "Bit-perfect · 96 kHz · MacBook Pro Speakers" |
| **Waiting for device** | `!hoggedByUs && holderPid` | amber · "Waiting for MacBook Pro Speakers — in use by {holderName}". Position shows the paused state honestly; playback resumes by itself when the holder releases (observed). Tooltip/popover offers **Play shared instead** (turns the mode off). |
| **Device limit** | hoggedByUs but `srcRate > deviceMaxRate` (or no matching rate) | amber · "Device max 48 kHz — resampled". Keeps playing. |
| **Not bit-perfect** | any other mismatch (e.g. rate didn't follow) | amber with the reason |
| **Device gone** | `!devicePresent` (unplugged) | turn the mode off, `notify()` "{device} disconnected — Bit-perfect mode off". |

Only positive, verified evidence turns the badge green.

## Non-native tracks

Tracks the engine can't play (per-track browser-engine fallback) play through the shared
WebKit output while mpv may still hold the hog. **To verify in implementation:** whether mpv
releases the exclusive AO when the deck idles; if not, such a track would be silent. Minimum
behaviour: the badge shows "Not bit-perfect: browser engine", and the engine must release the
device before a fallback track plays.

## Platform

- **macOS:** full design above.
- **Windows:** the engine already sets WASAPI exclusive, but pinning and verification were not
  spiked. v1 hides the toggle on Windows; a follow-up spike repeats this one there
  (device pinning by ID, detecting a busy device, rate following).

## Implementation map

*As built:* the overlay is applied **in the engine**, not by the frontend sending effective
values — `DspSettings` keeps the real EQ/RG/speed/exclusive next to the pin and every
`apply_*` / `deck_volume` substitutes neutral values while it is set, so no frontend path
(fade ramp, preloaded deck, control API) can leak one. "Reload now" is mpv's `ao-reload`, not
a replay at the current position (a replay re-armed scrobbling). The frontend only renders:
lock, dim, badge, modal.

- **Backend (`mpv_engine`)**
  - `apply_bit_perfect(Option<DevicePin>)`: sets `audio-device` (pinned UID or `auto`),
    `gapless-audio` (`weak`/`yes`), and exclusive on both decks; cached on `EngineHandle`
    like the other DSP (`pending_dsp`).
  - Output verifier: promote the probe's CoreAudio reads (hog pid, nominal/available rates,
    device list, UID, name) to a real module; observe `audio-out-params` + 1s watchdog; emit
    `engine-output`. `holderName` via `proc_name` (libc, already a unix dep).
  - Command `engine_default_output_device()` → `{ uid, name }` for the pin at enable time.
  - Retire the probe env var once the verifier exists (or keep it as a debug dump of the same data).
- **Frontend**
  - `bitPerfectMode` session state (App) + effective-value overlay where EQ / RG / speed /
    volume / exclusive are mirrored to `nativeEngine` (`usePlayback.ts` effects, App's
    exclusive handler).
  - `handleVolume` guard + hint toast.
  - `bitPerfect.ts`: add `speed`; add `resolveBitPerfectState(output, blockers)` (pure,
    unit-tested — the table above).
  - Bar toggle + confirmation modal (`ds-modal`, no overlay-click dismiss); badge tooltip.
  - Settings → Playback exclusive row reads the same state.
- **Control API / MCP:** `get_status` reports `bitPerfect: { on, state, device, rates }`.
- **Tests:** `resolveBitPerfectState` table tests; engine test that `apply_bit_perfect` sets
  `gapless-audio=weak` + pinned `audio-device` on both decks (ao=null); overlay test that stored
  settings are unchanged after on → off.

## Decisions (locked)

- Name **"Bit-perfect"** (not "Audio Fidelity" / "Audiophile mode").
- **Overlay**, not a settings macro.
- Enabling mid-track **reloads now** at the current position.
- Volume input while on: **ignored**, with a hint.
- **Not persisted** across restarts.
- Busy device: **wait visibly** (option a), with "Play shared instead" as the escape hatch.
- **Volume while on = the device's own volume** (added after live testing: locking the player at
  100% left built-in speakers and headphones with no way to turn down at all). Viboplr's volume
  controls set `kAudioDevicePropertyVolumeScalar` on the pinned device; mpv stays at full scale.
  Enabling lowers the device by the player's old volume so loudness never jumps; disabling
  restores it. Devices without a settable volume keep the 100% lock.
- **The Mac's volume keys don't reach the held device — accepted.** macOS moves the system
  output off a hogged device and silently refuses to point it back (spiked: set returns 0, the
  default doesn't move). Rejected alternatives: an Accessibility-permission key tap, and a
  shared (non-exclusive) rate-switching variant. The confirmation, the volume tooltip and the
  help page say so.
- **Transient mismatches get a 2s grace window** (`isOutputSettling`): exclusive access and the
  device's rate switch each land ~1s after the output opens, which flashed amber on every enable
  and every rate change. A busy device and a device limit are never deferred.
