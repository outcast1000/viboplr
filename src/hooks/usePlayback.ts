import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack, ResolvedTrackSource, EngineSource } from "../types";
import type { ScrobbleOutcome } from "../utils/scrobblers";
import { isVideoTrack, shouldScrobble } from "../utils";
import { parseUrlScheme } from "../queueEntry";
import { store } from "../store";
import { driveProgressMachine } from "../playback/progressMachine";
import {
  describePlaybackFailure,
  describeLocalPlaybackFailure,
  engineErrorMessage,
  probeNetworkStatus,
  isFormatPlaybackError,
  nextPlayIntent,
  shouldAutoSkipFailure,
  MAX_CONSECUTIVE_AUTO_SKIPS,
  ENGINE_UNAVAILABLE_ERROR,
  AUDIO_OUTPUT_PLAYBACK_ERROR,
  VIDEO_UNAVAILABLE_ERROR,
  UNPLAYABLE_SOURCE_ERROR,
  type PlayIntent,
} from "../playback/playbackErrors";
import { track as trackTelemetry, sourceClass } from "../telemetry";
import { classifyErrorKind } from "../utils/errorKind";
import {
  nativeEngine,
  type EnginePositionEvent,
  type EngineDurationEvent,
  type EngineTrackChangedEvent,
  type EngineEndedEvent,
  type EnginePlaybackRestartEvent,
  type EngineStateEvent,
  type EngineErrorEvent,
  type EngineIcyTitleEvent,
  type EngineBufferEvent,
  type EngineLevelEvent,
} from "../playback/nativeEngine";
import { updatePlaybackBuffer, clearPlaybackBuffer } from "../playback/bufferStore";
import { setPlaybackLevel, clearPlaybackLevel } from "../playback/levelStore";
import { subscribe, combineUnlisten } from "../utils/tauriEvents";
import { setPlaybackPosition, getPlaybackPosition } from "../playback/positionStore";
import { noteNativeFailure, clearNativeRetries, streamLadderStep, fallBackFromFailedSource } from "../playback/playbackRetry";
import type { EqClipProtection, EqMode } from "../eqPresets";
import { useAssignRef } from "./useLatestRef";
import { CHAIN_EXHAUSTED_MESSAGE, type TrackFailureStage } from "../playback/trackFailures";

/** What usePlayback tells the per-entry failure record (see its last param). */
export interface PlaybackFailureInfo {
  /** How far the play got — see `TrackFailureStage`. */
  stage: TrackFailureStage;
  summary: string;
  engineError?: string | null;
  tries?: number | null;
}

export interface PlaybackOutcomeHandlers {
  failed: (key: string, info: PlaybackFailureInfo) => void;
  started: (key: string) => void;
}

/** Engine attempts allowed for one remote track before its failure is shown.
 *  Three because each one costs a fresh resolve (a yt-dlp run, seconds) and the
 *  last descends a rung of the stream ladder (see playbackRetry); a fourth
 *  would mostly buy delay. */
const NATIVE_RETRY_ATTEMPTS = 3;

/** Prefix of the keys `playClip` mints. The engine's events carry the key, and
 *  the main session ignores every one of these. */
const CLIP_KEY_PREFIX = "clip:";

function logPlayback(message: string) {
  // Fire-and-forget: this IS the logger. Reporting its own failure through
  // console.error would recurse into the error log for no user-visible gain.
  invoke("write_frontend_log", { level: "info", message, section: "playback" }).catch(() => {}); // eslint-disable-line no-restricted-syntax
}

// A play request is "current" only while no later request has started. Used to
// decide whether a caught playback error / loading-state reset belongs to the
// active track or to a superseded one. Pure so it can be unit-tested without
// the hook.
export function isCurrentPlayGeneration(captured: number, current: number): boolean {
  return captured === current;
}

export type HandlePlayOutcome = "play" | "bail" | "retry" | "fail";

// Decides what handlePlay should do once its stream resolution settles.
//
// `resolveTrackSrc` returns an empty-src sentinel whenever ITS resolve generation
// was bumped mid-flight — which happens not only on a newer play but also when a
// concurrent preload/prefetch resolves. Conflating "empty src" with "I was
// superseded by a newer play" is the bug behind the Next-stops-playback freeze:
// a silent bail while THIS play is still current leaves the player stuck on the
// previous track with the queue index already advanced — and nothing logged.
//
//  - playStillCurrent=false → a newer handlePlay bumped playGeneration and owns
//    currentTrack; bail silently regardless of src.
//  - has src + still current → play.
//  - empty src + still current → the resolve (not the play) was superseded; no one
//    else will set currentTrack, so recover: re-resolve once (`retry`), then if it
//    is STILL empty surface it via the error path (`fail`) rather than freeze.
export function decideHandlePlayOutcome(
  playStillCurrent: boolean,
  hasSrc: boolean,
  alreadyRetried: boolean,
): HandlePlayOutcome {
  if (!playStillCurrent) return "bail";
  if (hasSrc) return "play";
  return alreadyRetried ? "fail" : "retry";
}

export function usePlayback(
  restoredRef: React.RefObject<boolean>,
  peekNextRef: React.RefObject<() => QueueTrack | null>,
  crossfadeSecsRef: React.RefObject<number>,
  advanceIndexRef: React.RefObject<() => void>,
  /** Called when the scrobble threshold is crossed; App hands the play to
   *  every scrobbler that accepts it (Settings → Playback → Scrobbling). `offered`: some
   *  scrobbler was on for this media type, so the play is settled and never
   *  offered again. `accepted`: one of them took it — what `scrobbled`
   *  reports. Offered to nobody, it is asked again on later ticks, so a switch
   *  turned on mid-play still records it. */
  onScrobbleRef: React.RefObject<(track: QueueTrack) => ScrobbleOutcome>,
  resolveTrackSrcRef: React.RefObject<(track: QueueTrack, opts?: { preload?: boolean }) => Promise<ResolvedTrackSource>>,
  prefetchNextRef: React.RefObject<() => void>,
  // True once libmpv has loaded. App owns the capability probe. Nothing plays
  // without it — a play then surfaces ENGINE_UNAVAILABLE_ERROR.
  useNativeEngineRef: React.RefObject<boolean>,
  // True when the engine can also render video (macOS and Windows). Gates
  // video tracks.
  useNativeVideoRef: React.RefObject<boolean>,
  // App points this at `() => handleNext("auto")` — fires when a track ends
  // with nothing gapless-armed.
  onNativeAutoEndedRef: React.RefObject<() => void>,
  // App points this at "toast + handleNext('auto')" — the auto-skip surface for
  // a playback failure on a track the queue advanced to (not a user click).
  // See surfacePlaybackFailure; when unassigned the modal path is used instead.
  onAutoSkipFailureRef: React.RefObject<((track: QueueTrack, error: string) => void) | null>,
  // Seconds before the end at which to ask auto-continue for the next track
  // (App: utils/autoContinue.ts → prefetchLeadSecs). Absent = the preload lead.
  prefetchLeadRef?: React.RefObject<number>,
  // Per-entry failure record for the queue row (playback/trackFailures.ts):
  // `failed` when a play is given up on — both surfaces, auto-skip and modal —
  // and `started` once the engine reports real progress for an entry, which is
  // what clears it. App points this at useStreamResolution's recorder.
  playbackOutcomeRef?: React.RefObject<PlaybackOutcomeHandlers | null>,
) {
  const [currentTrack, setCurrentTrack] = useState<QueueTrack | null>(null);
  const [playing, setPlaying] = useState(false);
  /**
   * Playback was STOPPED, as distinct from paused.
   *
   * Both leave `playing` false, but they are different states and always have
   * been — `handleStop` also rewinds to 0 and drops the asset — the difference
   * simply had no name until something outside this hook needed to read it.
   * Visualizers do: a deck depicts a stop as the arm returning to its rest and a
   * pause as the arm lifting where it stands, and with one flag it can only ever
   * draw one of the two.
   *
   * Self-clearing on the rising edge of `playing`, so no play path has to
   * remember to reset it.
   */
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    if (playing) setStopped(false);
  }, [playing]);
  // The live position deliberately does NOT live in React state — it ticks
  // ~4×/sec and would re-render the whole tree from App down. It goes to the
  // external positionStore instead; display surfaces subscribe individually
  // via usePlaybackPosition().
  const [durationSecs, setDurationSecs] = useState(0);
  const [volume, setVolume] = useState(1.0);
  const [muted, setMuted] = useState(false);
  /**
   * Playback rate, as a deck's speed selector rather than a tempo tool: pitch
   * rides along with it (mpv's `audio-pitch-correction` is off).
   *
   * NOT persisted, on purpose. A rate is audible but easy to forget you set, and
   * one restored silently at 1.35x on a fresh launch reads as "my library got
   * transposed" rather than "I left the deck on 45". Every start is 1x.
   */
  const [playbackRate, setPlaybackRate] = useState(1);

  const [eqEnabled, setEqEnabled] = useState(false);
  const [eqMode, setEqMode] = useState<EqMode>("advanced");
  const [eqPreset, setEqPreset] = useState<string>("flat");
  const [eqGains, setEqGains] = useState<number[]>(() => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const [eqPreGainDb, setEqPreGainDb] = useState<number>(0);
  // Simple mode shelf gains (dB). Independent of the 10-band eqGains so switching
  // modes is non-destructive — each mode keeps its own settings.
  const [eqBassDb, setEqBassDb] = useState<number>(0);
  const [eqTrebleDb, setEqTrebleDb] = useState<number>(0);
  // How a simple-mode boost is kept from clipping: "limiter" (loud; heavy
  // boosts pump on dense material) or "headroom" (attenuate by the boost
  // amount; clean but quieter). See EqClipProtection in eqPresets.ts.
  const [eqClipProtection, setEqClipProtection] = useState<EqClipProtection>("limiter");
  // ReplayGain: per-track loudness normalization, applied by the engine (mpv
  // reads the tags itself). Mode "off" | "track" | "album"; preamp dB is added
  // on top; preventClip caps the gain so the (normalized) peak stays <= 0 dBFS.
  const [rgMode, setRgMode] = useState<"off" | "track" | "album">("off");
  const [rgPreampDb, setRgPreampDb] = useState<number>(0);
  const [rgPreventClip, setRgPreventClip] = useState<boolean>(true);
  const trackChangeSourceRef = useRef<"user" | "auto">("user");
  // Whose track the current play attempt is FOR (user click vs queue advance) —
  // decides how a failure surfaces (error modal vs auto-skip). Maintained by
  // nextPlayIntent so the engine-error same-track replay (which comes through
  // handlePlay as "auto") inherits a user click instead of demoting it.
  const playIntentRef = useRef<PlayIntent | null>(null);
  // Consecutive playback failures that were auto-skipped without any playback
  // progress in between — the circuit breaker's counter (see
  // surfacePlaybackFailure). Reset on user plays and on real progress ticks.
  const autoSkipStreakRef = useRef(0);
  // The entry `playbackOutcomeRef.started` was last sent for — so it fires once
  // per entry, not on every position tick. Reset when that entry fails.
  const startedReportedKeyRef = useRef<string | null>(null);
  // Monotonic id bumped on every play request. A superseded request (a newer
  // play started while this one was resolving) discards its outcome instead of
  // flashing a playback-error modal or claiming the now-playing bar.
  const playGenerationRef = useRef(0);

  // Mirror for the once-mounted engine-event subscriptions, which would
  // otherwise close over the first render's currentTrack.
  const currentTrackRef = useRef<QueueTrack | null>(currentTrack);
  useAssignRef(currentTrackRef, currentTrack);

  // --- Engine session state -------------------------------------------------
  // Non-null while the engine is playing (or paused on) `key` for the main
  // player. The key doubles as the play-generation guard for engine events:
  // events carrying another key are stale. Null with a currentTrack means the
  // track is loaded but not open in the engine (restored at launch, cued by
  // loadPaused, or handed over to a clip) — the next play opens it.
  const nativeSessionRef = useRef<{ key: string; track: QueueTrack } | null>(null);
  // The track the engine last reported a position for: proof it has opened
  // that file, so its live decode facts (codec, rate) describe it.
  const nativeReportingKeyRef = useRef<string | null>(null);
  /** Whether the engine is decoding `trackKey` right now — its media info is
   *  about that track, not the one before. */
  const isEngineDecoding = useCallback(
    (trackKey: string) => nativeSessionRef.current?.key === trackKey && nativeReportingKeyRef.current === trackKey,
    [],
  );
  // Tracks whose preload failed past their retries this session. They are not
  // armed for gapless again — the explicit play at the track boundary opens
  // them, and surfaces the failure if it recurs.
  const unarmableKeysRef = useRef<Set<string>>(new Set());
  // Gapless-armed next track. `src` keeps the webview URL so waveforms keep
  // working after promotion; `engineSource` becomes the session's source then.
  const nativePreloadedRef = useRef<{
    key: string;
    track: QueueTrack;
    src: string | null;
    engineSource: EngineSource;
  } | null>(null);
  // The source the last preload was handed to the engine with, set BEFORE the
  // engine_preload call — a refusal can arrive before nativePreloadedRef is
  // armed, and its retry decision needs that track's source, not the session's.
  const preloadEngineSourceRef = useRef<{ key: string; source: EngineSource } | null>(null);
  const nativePreloadingRef = useRef(false);
  // Last position reported by engine-position — the resume point for a retry
  // after an engine error, and for resuming a session handed over to a clip.
  const nativeLastPositionRef = useRef(0);
  // True between issuing engine_start_crossfade and the engine's
  // track-changed (or any session reset) — stops the progress machine from
  // re-triggering the fade every position tick.
  const nativeFadingRef = useRef(false);
  // The source the current session was opened from. A retry after an engine
  // error is only worth it for a remote one: a local file's failure is
  // deterministic (a codec the engine can't decode).
  const lastEngineSourceRef = useRef<EngineSource | null>(null);
  // The clip (see playClip) that owns the engine right now, if any.
  const clipKeyRef = useRef<string | null>(null);
  const clipSeqRef = useRef(0);
  // Told when a main play or Stop takes the engine from that clip — its
  // events stop arriving then, so without this the owner waits forever.
  const clipLostRef = useRef<(() => void) | null>(null);
  // True while the session is a VIDEO session: the engine renders into a native
  // layer under the webview and App punches the CSS hole + reports the
  // container bounds while this is set.
  const [nativeVideoActive, setNativeVideoActive] = useState(false);
  // True once the current video session is actually presenting frames (the
  // `engine-playback-restart` signal — mpv is displaying its first frame; NOT
  // `engine-position`/VO-reconfig, which fire before the frame is on screen).
  // App keeps the see-through hole opaque until this flips, so a fresh start
  // never reveals the transparent window before mpv has painted into the
  // child. Reset per session start. There is deliberately no wall-clock
  // fallback: a 1.5s timer used to reveal a slow-loading or broken video over
  // an empty surface, showing the desktop through the hole. A video with no
  // picture keeps the hole opaque (app background) instead.
  const [nativeVideoPresenting, setNativeVideoPresenting] = useState(false);
  const nativeVideoPresentingRef = useRef(false);
  // Fullscreen for video = WINDOW fullscreen + the `.video-container--native-fs`
  // full-window pin (DOM element-fullscreen would move the webview to its own
  // space, away from the native layer). This state is the source of truth; the
  // window follows it.
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  // Live stream title (ICY StreamTitle) for internet-radio sessions — the
  // song the station is currently playing. Null for ordinary tracks (the
  // engine's media-title then equals the track's own title and is dropped).
  const [icyTitle, setIcyTitle] = useState<string | null>(null);
  // The buffer readout (how far the source has buffered / stalled flag) lives
  // in the external bufferStore, not React state — its edge advances several
  // times a second while a stream fills, and as App-level state that
  // re-rendered the whole tree per move. Fed below; drawn by the surfaces
  // that subscribe via usePlaybackBuffer().

  /** Readouts that describe *this* stream and nothing else. Reset together at
   *  every session boundary (explicit play, stop, engine track change, engine
   *  error) so a new track can never inherit the last one's radio title or
   *  buffered edge. One call site per boundary, not one per readout. */
  function clearStreamReadouts() {
    setIcyTitle(null);
    clearPlaybackBuffer();
    clearPlaybackLevel();
  }

  function setWindowFullscreen(fullscreen: boolean) {
    import("../utils/windowFullscreen")
      .then(({ applyWindowFullscreen }) => applyWindowFullscreen(fullscreen))
      .catch((e) => console.error("Failed to set window fullscreen:", e));
  }

  // Leaving the video session (track ended, stop, error) must also leave
  // fullscreen — otherwise the window stays fullscreen with the app surfaces
  // hidden by the native-fs CSS.
  useEffect(() => {
    if (!nativeVideoActive && nativeFullscreen) {
      setNativeFullscreen(false);
      setWindowFullscreen(false);
    }
  }, [nativeVideoActive, nativeFullscreen]);

  // Where the next open of the current track starts: set by seeking while no
  // session is open, by loadPaused, and by an engine-error retry.
  const pendingSeekRef = useRef(0);
  // `scrobbledRef`: this play was offered to a scrobbler (so it is handed
  // over at most once). `scrobbled`: some scrobbler took it — the bar's
  // checkmark. They differ when every scrobbler is off for this media type.
  const scrobbledRef = useRef(false);
  const [scrobbled, setScrobbled] = useState(false);
  const scrobbleAcceptedRef = useRef(false);
  // Bumped by every reset, so a late `settled` answer can't put a checkmark
  // on the next play.
  const scrobbleGenRef = useRef(0);
  // Runs inside the position handler, so it must never throw into it — that
  // would skip the tick's preload / crossfade decisions.
  function crossScrobbleThreshold(track: QueueTrack) {
    let outcome: ScrobbleOutcome;
    try {
      outcome = onScrobbleRef.current(track);
    } catch (e) {
      console.error("Failed to hand the play to the scrobblers:", e);
      outcome = { offered: true, accepted: false };
    }
    if (!outcome.offered) return;
    scrobbledRef.current = true;
    scrobbleAcceptedRef.current = outcome.accepted;
    setScrobbled(outcome.accepted);
    if (outcome.settled) {
      const gen = scrobbleGenRef.current;
      outcome.settled.then((accepted) => {
        if (scrobbleGenRef.current !== gen) return;
        scrobbleAcceptedRef.current = accepted;
        setScrobbled(accepted);
      }).catch((e) => console.error("Failed to settle the scrobble:", e));
    }
  }
  function resetScrobble(state: { crossed: boolean; accepted: boolean } = { crossed: false, accepted: false }) {
    scrobbleGenRef.current++;
    scrobbledRef.current = state.crossed;
    scrobbleAcceptedRef.current = state.accepted;
    setScrobbled(state.accepted);
  }
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [failedTrack, setFailedTrack] = useState<QueueTrack | null>(null);
  // The webview URL of the resolved source — not what the engine plays, but
  // what the waveform's Web Audio provider fetches.
  const [currentAssetUrl, setCurrentAssetUrl] = useState<string | null>(null);
  // Last source URL handed to playWithSrc — read by the play-failure paths,
  // where currentAssetUrl would be a stale closure.
  const lastPlaySrcRef = useRef<string | null>(null);
  const [loadingTrack, setLoadingTrack] = useState<QueueTrack | null>(null);
  const playStartedAtRef = useRef(0);
  // Set by swapCurrentFile: the scrobble state of a session that is resuming
  // on a replaced file, restored by playWithSrc for that key instead of reset.
  const resumeScrobbleRef = useRef<{ key: string; crossed: boolean; accepted: boolean; startedAt: number } | null>(null);
  const playingRef = useRef(playing);
  useAssignRef(playingRef, playing);

  const prefetchRequestedRef = useRef(false);
  // Tier-1 video preload: the next VIDEO track can't be gapless-armed (the
  // standby deck has no video surface), but its stream URL can be pre-resolved
  // so the transition doesn't wait on a slow resolver (e.g. yt-dlp). Cached by
  // key here; consumed once by handlePlay.
  const videoPreresolvedRef = useRef<{ key: string; resolved: ResolvedTrackSource } | null>(null);
  const videoPreresolvingRef = useRef(false);
  // Key we've already attempted to pre-resolve for the current preload window.
  // A video next-track never sets preloadedKey/isPreloading (nothing to arm),
  // so driveProgressMachine re-issues its preloadTrack on every ~4 Hz tick;
  // without this the resolve is re-run whenever the success cache above isn't
  // set (e.g. the shared resolve generation was bumped mid-flight, so the
  // resolve returned the empty-src sentinel), firing yt-dlp again and again.
  // Reset per track change in invalidatePreload() so a new next-track re-tries.
  const videoPreresolveAttemptedKeyRef = useRef<string | null>(null);

  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const playbackRateRef = useRef(playbackRate);
  useAssignRef(playbackRateRef, playbackRate);

  // Diagnostic for the Next-stops-playback class of bug: a play request that does
  // NOT cleanly start its track. Captures the generation snapshot so a recurrence
  // is explainable from the log instead of being invisible.
  //   bail  → superseded by a newer play (expected on rapid skipping): file log only.
  //   retry → resolve superseded but this play is still current (the regression
  //           condition): also surfaced in the devtools console.
  //   fail  → still no source after a fresh resolve: console + the catch's error.
  function diagnosePlayOutcome(
    outcome: HandlePlayOutcome,
    track: QueueTrack,
    capturedGen: number,
    hadSrc: boolean,
  ): void {
    if (outcome === "play") return;
    const detail =
      `track="${track.artist_name ?? "?"} — ${track.title}" key=${track.key} ` +
      `playGen captured=${capturedGen} current=${playGenerationRef.current} ` +
      `resolvedSrc=${hadSrc ? "set" : "EMPTY"} session=${nativeSessionRef.current?.key ?? "none"} ` +
      `nowPlaying="${currentTrack?.title ?? "none"}"`;
    logPlayback(`PLAY ${outcome.toUpperCase()}: ${detail}`);
    if (outcome === "retry" || outcome === "fail") {
      console.warn(`[playback] play ${outcome}: ${detail}`);
    }
  }

  // Reveal the video surface for the current session: flip presenting so App
  // drops the opaque backstop over the hole (and the cached still bridging it).
  // Idempotent (first caller wins); driven by `engine-playback-restart` with
  // `hasVideo`.
  function markNativeVideoPresenting() {
    if (nativeVideoPresentingRef.current) return;
    nativeVideoPresentingRef.current = true;
    setNativeVideoPresenting(true);
  }

  function resetNativeVideoPresentation() {
    nativeVideoPresentingRef.current = false;
    setNativeVideoPresenting(false);
  }

  /** Forget the open session without touching the engine (the caller stops,
   *  replaces or hands it over). Clears every per-session readout. */
  function endNativeSession() {
    nativeSessionRef.current = null;
    nativePreloadedRef.current = null;
    nativeFadingRef.current = false;
    setNativeVideoActive(false);
    resetNativeVideoPresentation();
    clearStreamReadouts();
  }

  // Mirror volume/mute to the engine (cached backend-side until it runs).
  useEffect(() => {
    volumeRef.current = volume;
    mutedRef.current = muted;
    nativeEngine.setVolume(volume, muted).catch(console.error);
  }, [volume, muted]);

  useEffect(() => {
    nativeEngine.setEq({
      enabled: eqEnabled,
      mode: eqMode,
      gains: eqGains,
      preGainDb: eqPreGainDb,
      bassDb: eqBassDb,
      trebleDb: eqTrebleDb,
      clipProtection: eqClipProtection,
    }).catch(console.error);
  }, [eqEnabled, eqMode, eqGains, eqPreGainDb, eqBassDb, eqTrebleDb, eqClipProtection]);

  useEffect(() => {
    nativeEngine.setReplayGain({
      mode: rgMode,
      preampDb: rgPreampDb,
      preventClip: rgPreventClip,
    }).catch(console.error);
  }, [rgMode, rgPreampDb, rgPreventClip]);

  // Push the playback rate to the engine. mpv applies it to BOTH decks — the
  // idle one is what gapless preloads into, and a deck left at 1.0 would snap
  // back to normal speed at the track change.
  useEffect(() => {
    nativeEngine.setSpeed(playbackRate).catch(console.error);
  }, [playbackRate]);

  const lastLoggedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentTrack && currentTrack.key !== lastLoggedKeyRef.current) {
      lastLoggedKeyRef.current = currentTrack.key;
      logPlayback(`Track changed: ${currentTrack.artist_name ?? "?"} — ${currentTrack.title} (key=${currentTrack.key})`);
    } else if (!currentTrack) {
      lastLoggedKeyRef.current = null;
    }
  }, [currentTrack]);
  // Persist volume and mute (guarded by restoredRef so startup defaults
  // don't overwrite the saved values before restore completes)
  useEffect(() => { if (restoredRef.current) store.set("volume", volume).catch(console.error); }, [volume]);
  useEffect(() => { if (restoredRef.current) store.set("muted", muted).catch(console.error); }, [muted]);

  function invalidatePreload() {
    videoPreresolvedRef.current = null;
    videoPreresolveAttemptedKeyRef.current = null;
    if (nativePreloadedRef.current) {
      nativePreloadedRef.current = null;
      nativeEngine.clearPreload().catch(console.error);
    }
  }

  // Tier-1 video preload: pre-resolve the next VIDEO's stream URL during the
  // current track (the slow part for e.g. yt-dlp) and cache it by key —
  // handlePlay consults this cache. Self-guarded so the machine may call it
  // every tick harmlessly.
  async function preresolveVideoNext(nextTrack: QueueTrack) {
    if (videoPreresolvingRef.current) return;
    if (videoPreresolvedRef.current?.key === nextTrack.key) return; // already prepared
    // Already attempted this key in the current preload window — don't re-run a
    // slow resolver every tick just because the success cache above wasn't set.
    if (videoPreresolveAttemptedKeyRef.current === nextTrack.key) return;
    videoPreresolveAttemptedKeyRef.current = nextTrack.key;
    videoPreresolvingRef.current = true;
    logPlayback(`Preload: pre-resolving video "${nextTrack.artist_name ?? "?"} — ${nextTrack.title}"`);
    try {
      const resolved = await resolveTrackSrcRef.current(nextTrack, { preload: true });
      // Only cache a usable src for a track that's still the pending next one.
      // (resolveTrackSrc returns an empty-src sentinel if its generation bumped.)
      if (resolved?.src && peekNextRef.current()?.key === nextTrack.key) {
        videoPreresolvedRef.current = { key: nextTrack.key, resolved };
        logPlayback(`Preload: video ready "${nextTrack.title}"`);
      }
    } catch (e) {
      console.error("Video pre-resolve error:", e);
    } finally {
      videoPreresolvingRef.current = false;
    }
  }

  // --- Engine session -------------------------------------------------------
  // The `engine-*` events below are the player's whole view of playback. Only
  // reads refs, so the once-captured closure in the mount effect stays valid.

  async function nativePreloadNext(next: QueueTrack) {
    if (nativePreloadingRef.current) return;
    if (isVideoTrack(next)) {
      // The standby deck has no video surface, so no gapless/crossfade for
      // video — but still pre-resolve the URL so the transition doesn't wait.
      preresolveVideoNext(next);
      return;
    }
    if (unarmableKeysRef.current.has(next.key)) return;
    nativePreloadingRef.current = true;
    logPlayback(`Native preload: resolving "${next.artist_name ?? "?"} — ${next.title}"`);
    try {
      const resolved = await resolveTrackSrcRef.current(next, { preload: true });
      if (!resolved.src) return;
      const enriched = resolved.patch ? { ...next, ...resolved.patch } : next;
      // Video, or a source the engine can't open: stay unarmed — the engine's
      // `engine-ended` then routes the next track through the explicit
      // handlePlay path, which surfaces whatever is wrong with it.
      if (isVideoTrack(enriched) || !resolved.engineSource) return;
      if (!nativeSessionRef.current) return; // session ended while resolving
      preloadEngineSourceRef.current = { key: enriched.key, source: resolved.engineSource };
      await nativeEngine.preload({
        source: resolved.engineSource,
        trackKey: enriched.key,
        crossfade: crossfadeSecsRef.current > 0,
      });
      nativePreloadedRef.current = {
        key: enriched.key,
        track: enriched,
        src: resolved.src,
        engineSource: resolved.engineSource,
      };
      logPlayback(`Native preload: armed "${enriched.title}"`);
    } catch (e) {
      console.error("Native preload error:", e);
    } finally {
      nativePreloadingRef.current = false;
    }
  }

  useEffect(() => {
    return combineUnlisten(
      subscribe<EnginePositionEvent>("engine-position", ({ payload }) => {
        if (nativeSessionRef.current?.key !== payload.trackKey) return;
        nativeLastPositionRef.current = payload.positionSecs;
        nativeReportingKeyRef.current = payload.trackKey;
        setPlaybackPosition(payload.positionSecs);

        // NOTE: presenting is NOT flipped here. `time-pos` advances before the
        // video output has painted a frame into the native surface, so revealing
        // the see-through hole on the first tick flashes the empty window
        // (background, then desktop) until mpv's real first present. The
        // accurate signal is `engine-playback-restart` (see its subscription).

        // First real progress for this entry: it plays, so a failure noted on its
        // queue row is no longer true. Once per entry until it fails again.
        if (payload.positionSecs > 0 && startedReportedKeyRef.current !== payload.trackKey) {
          startedReportedKeyRef.current = payload.trackKey;
          playbackOutcomeRef?.current?.started(payload.trackKey);
        }

        const track = currentTrackRef.current;
        // Real playback progress — a track is actually playing, so the streak
        // of consecutive auto-skipped failures (surfacePlaybackFailure's
        // circuit breaker) starts over.
        if (autoSkipStreakRef.current !== 0 && payload.positionSecs > 1) autoSkipStreakRef.current = 0;
        // Scrobble threshold check (Last.FM rules). Who records the play, per
        // media type, is Settings → Playback → Scrobbling — decided by App's onScrobble.
        if (!scrobbledRef.current && track && shouldScrobble(payload.positionSecs, track.duration_secs)) {
          crossScrobbleThreshold(track);
        }

        const duration = payload.durationSecs ?? track?.duration_secs ?? 0;
        const actions = driveProgressMachine({
          position: payload.positionSecs,
          duration,
          crossfadeSecs: crossfadeSecsRef.current,
          next: peekNextRef.current(),
          preloadedKey: nativePreloadedRef.current?.key ?? null,
          preloadReady: nativePreloadedRef.current !== null,
          isPreloading: nativePreloadingRef.current,
          isCrossfading: nativeFadingRef.current,
          prefetchRequested: prefetchRequestedRef.current,
          prefetchLeadSecs: prefetchLeadRef?.current,
          rate: playbackRateRef.current,
        });
        if (actions.requestPrefetch) {
          logPlayback(`Prefetch: requesting auto-continue (${(duration - payload.positionSecs).toFixed(1)}s remaining)`);
          prefetchRequestedRef.current = true;
          prefetchNextRef.current();
        }
        if (actions.invalidatePreload && nativePreloadedRef.current) {
          nativePreloadedRef.current = null;
          nativeEngine.clearPreload().catch(console.error);
        }
        if (actions.preloadTrack) nativePreloadNext(actions.preloadTrack);
        if (actions.startCrossfade) {
          nativeFadingRef.current = true;
          nativeEngine.startCrossfade(crossfadeSecsRef.current).catch((e) => {
            console.error("Native crossfade failed to start:", e);
            nativeFadingRef.current = false;
          });
        }
      }),
      subscribe<EngineDurationEvent>("engine-duration", ({ payload }) => {
        if (nativeSessionRef.current?.key !== payload.trackKey) return;
        if (payload.durationSecs > 0) setDurationSecs(payload.durationSecs);
      }),
      subscribe<EngineTrackChangedEvent>("engine-track-changed", ({ payload }) => {
        const promoted = nativePreloadedRef.current;
        if (!promoted || promoted.key !== payload.trackKey) return;
        // The engine swapped to the armed track (gapless or crossfade).
        // Armed tracks are always audio (video is never gapless/crossfade-armed).
        nativePreloadedRef.current = null;
        nativeSessionRef.current = { key: promoted.key, track: promoted.track };
        nativeLastPositionRef.current = 0;
        nativeFadingRef.current = false;
        setNativeVideoActive(false);
        resetNativeVideoPresentation();
        clearStreamReadouts();
        trackChangeSourceRef.current = "auto";
        playIntentRef.current = nextPlayIntent(playIntentRef.current, promoted.track.key, "auto");
        setCurrentTrack(promoted.track);
        prefetchRequestedRef.current = false;
        setCurrentAssetUrl(promoted.src);
        lastPlaySrcRef.current = promoted.src;
        lastEngineSourceRef.current = promoted.engineSource;
        setPlaybackPosition(0);
        setDurationSecs(promoted.track.duration_secs ?? 0);
        resetScrobble();
        playStartedAtRef.current = Math.floor(Date.now() / 1000);
        advanceIndexRef.current();
      }),
      subscribe<EngineEndedEvent>("engine-ended", ({ payload }) => {
        if (nativeSessionRef.current?.key !== payload.trackKey) return;
        endNativeSession();
        onNativeAutoEndedRef.current();
      }),
      subscribe<EnginePlaybackRestartEvent>("engine-playback-restart", ({ payload }) => {
        // mpv is now displaying the first frame after load — the accurate
        // "surface has real pixels" signal (the decode clock / VO reconfig both
        // fire earlier, before the frame is actually on screen). Reveal the
        // native hole now; it's been held opaque since the session started.
        // Only when mpv has a picture: a video whose picture failed to decode
        // still restarts (audio-only), and revealing over that empty surface
        // shows the desktop through the transparent window. The hole stays
        // opaque instead; a late video output re-sends with hasVideo.
        if (nativeSessionRef.current?.key !== payload.trackKey) return;
        if (!payload.hasVideo) return;
        markNativeVideoPresenting();
      }),
      subscribe<EngineStateEvent>("engine-state", ({ payload }) => {
        // The one event whose key is optional — so a clip's play/pause can't
        // be told from the main session's by the key check below alone.
        if (payload.trackKey?.startsWith(CLIP_KEY_PREFIX) || clipKeyRef.current) return;
        if (!nativeSessionRef.current) return;
        if (payload.trackKey && payload.trackKey !== nativeSessionRef.current.key) return;
        setPlaying(payload.playing);
      }),
      subscribe<EngineBufferEvent>("engine-buffer", ({ payload }) => {
        if (nativeSessionRef.current?.key !== payload.trackKey) return;
        updatePlaybackBuffer({
          stalled: payload.pausedForCache,
          readaheadSecs: payload.readaheadSecs,
          bufferedToSecs: payload.cacheEndSecs,
        });
      }),
      subscribe<EngineLevelEvent>("engine-level", ({ payload }) => {
        if (nativeSessionRef.current?.key !== payload.trackKey) return;
        const { peakDb, rmsDb } = payload;
        setPlaybackLevel(peakDb && rmsDb ? { peakDb, rmsDb } : null);
      }),
      subscribe<EngineIcyTitleEvent>("engine-icy-title", ({ payload }) => {
        if (nativeSessionRef.current?.key !== payload.trackKey) return;
        const title = payload.title.trim();
        const track = currentTrackRef.current;
        // Only direct http(s) sources can be live streams; local/scheme tracks
        // report their own tag title (or filename) here — not a live feed.
        const isDirectStream = !!track?.path && (track.path.startsWith("http://") || track.path.startsWith("https://"));
        // Before real ICY data arrives, mpv reports the URL's basename — drop it.
        const urlBasename = track?.path?.split("/").pop() ?? "";
        if (!isDirectStream || !title || title === track?.title || title === track?.path || title === urlBasename) {
          setIcyTitle(null);
        } else {
          setIcyTitle(title);
        }
      }),
      subscribe<EngineErrorEvent>("engine-error", ({ payload }) => {
        // A clip's failure belongs to whoever played the clip.
        if (payload.trackKey.startsWith(CLIP_KEY_PREFIX)) return;
        // A REMOTE source gets a few more attempts before its failure is shown,
        // each one re-resolved so it plays a freshly signed URL. That is the
        // whole of the recovery: the refusals are random (~1 in 4) and a new
        // link is a new draw, so the retries stay at FULL quality — only the
        // last one steps down a rung (see playbackRetry.streamLadderStep).
        // Local files are excluded: those failures are deterministic (a codec
        // mpv can't decode), so more attempts only delay the message.
        const session = nativeSessionRef.current?.key === payload.trackKey ? nativeSessionRef.current : null;
        const failedSource = session
          ? lastEngineSourceRef.current
          : preloadEngineSourceRef.current?.key === payload.trackKey
            ? preloadEngineSourceRef.current.source
            : null;
        const remote = failedSource?.kind === "http";
        const failures = noteNativeFailure(payload.trackKey);
        const retryNatively = remote && failures < NATIVE_RETRY_ATTEMPTS;
        if (nativePreloadedRef.current?.key === payload.trackKey) nativePreloadedRef.current = null;
        if (!session) {
          // A refused PRELOAD (the standby deck, not the playing track). Logged
          // here because nothing else records it: the next preload tick just
          // re-resolves, so without this the file log shows the retries but
          // never mpv's reason for refusing.
          if (!retryNatively) unarmableKeysRef.current.add(payload.trackKey);
          console.error(`[mpv] Preload failed (${payload.code}) for ${payload.trackKey}:`, payload.message);
          logPlayback(
            retryNatively
              ? `Preload error (${payload.code}) key=${payload.trackKey} — will re-resolve (attempt ${failures + 1}): ${payload.message}`
              : `Preload error (${payload.code}) key=${payload.trackKey} — not arming it again after ${failures} attempt(s): ${payload.message}`,
          );
          return;
        }
        endNativeSession();
        const sourceOrigin = lastPlaySrcRef.current
          ? (() => {
              try { return new URL(lastPlaySrcRef.current).origin; }
              catch { return "non-URL source"; }
            })()
          : "unknown source";
        console.error(
          `[mpv] Playback failed (${payload.code}) for ${payload.trackKey} from ${sourceOrigin}:`,
          payload.message,
        );
        logPlayback(
          retryNatively
            ? `Engine error (${payload.code}) key=${payload.trackKey} — re-resolving and retrying (attempt ${failures + 1}, stream ladder step ${streamLadderStep(payload.trackKey)}): ${payload.message}`
            : `Engine error (${payload.code}) key=${payload.trackKey} — giving up after ${failures} attempt(s): ${payload.message}`,
        );
        // The session's own track, not currentTrackRef: right after a gapless
        // promotion that ref still holds the previous track until React
        // commits, and bailing on the mismatch left the bar "playing" silence.
        const track = session.track;
        if (retryNatively) {
          trackTelemetry("engine_retry", { code: payload.code, error_kind: classifyErrorKind(payload.message) });
          // Replay the same track at the same position with a freshly resolved
          // source. `noteNativeFailure` above had to run BEFORE this replay:
          // handlePlay resolves synchronously from here.
          pendingSeekRef.current = nativeLastPositionRef.current;
          handlePlayRef.current(track, "auto");
          return;
        }
        // Out of retries for this source: play the track from the next entry
        // in its resolver chain (the Library copy under its current path, then
        // the plugin resolvers) before calling it a failure. Not for an audio
        // device that won't open — no other source fixes that.
        const deviceFailure = engineErrorMessage(payload.message) === AUDIO_OUTPUT_PLAYBACK_ERROR;
        if (!deviceFailure && fallBackFromFailedSource(track.key)) {
          logPlayback(`Engine error key=${track.key} — falling back to the next source in the chain`);
          pendingSeekRef.current = nativeLastPositionRef.current;
          handlePlayRef.current(track, "auto");
          return;
        }
        setPlaying(false);
        surfacePlaybackFailureRef.current(engineErrorMessage(payload.message, track.path), track, lastPlaySrcRef.current, "playback", {
          engineError: payload.message,
          tries: failures,
        });
      }),
    );
  }, []);

  async function handlePlay(track: QueueTrack, source: "user" | "auto" = "user") {
    // A deliberate play is a fresh start, so it starts at the top of the stream
    // ladder again — a track that stepped down to 480p an hour ago must not stay
    // there for the session. The engine-error replay comes through as "auto",
    // which is exactly the path that must NOT reset the ladder it just advanced.
    if (source === "user") {
      clearNativeRetries(track.key);
      unarmableKeysRef.current.delete(track.key);
    }
    // A user play is fresh intent: it claims the failure-surfacing intent and
    // restarts the auto-skip breaker. An "auto" play claims intent only for a
    // different track — see nextPlayIntent for why a same-key replay must not.
    if (source === "user") autoSkipStreakRef.current = 0;
    playIntentRef.current = nextPlayIntent(playIntentRef.current, track.key, source);
    const generation = ++playGenerationRef.current;
    // Tier-1: reuse a pre-resolved VIDEO source prepared during the previous
    // track (captured before invalidatePreload clears it). Single-use.
    const preVideo = videoPreresolvedRef.current;
    const reuseVideoResolved = preVideo && preVideo.key === track.key ? preVideo.resolved : null;
    invalidatePreload();
    setPlaybackError(null);
    setLoadingTrack(track);
    // Whether a source reached the engine — a failure before that is no source
    // (or no engine), not a source the player rejected.
    let handedToEngine = false;

    try {
      // Nothing can play without the engine — say so before running a resolver
      // that may take seconds (yt-dlp) only to fail at the end.
      if (!useNativeEngineRef.current) throw new Error(ENGINE_UNAVAILABLE_ERROR);
      let resolved = reuseVideoResolved ?? await resolveTrackSrcRef.current(track);
      if (reuseVideoResolved) logPlayback(`Play: used pre-resolved video "${track.title}"`);
      // resolveTrackSrc returns an empty-src sentinel whenever ITS resolve
      // generation was bumped mid-flight — by a newer play, but ALSO by a
      // concurrent preload/prefetch. Only the first case (a newer *play*) is
      // safe to bail on silently (that play owns currentTrack). An empty src
      // while THIS play is still current means the *resolve* was superseded but
      // nothing else will start the track. Recover by re-resolving once.
      let decision = decideHandlePlayOutcome(
        isCurrentPlayGeneration(generation, playGenerationRef.current),
        !!resolved.src,
        false,
      );
      if (decision === "retry") {
        diagnosePlayOutcome("retry", track, generation, !!resolved.src);
        resolved = await resolveTrackSrcRef.current(track);
        decision = decideHandlePlayOutcome(
          isCurrentPlayGeneration(generation, playGenerationRef.current),
          !!resolved.src,
          true,
        );
      }
      // A newer play request superseded this one — it owns currentTrack now.
      if (decision === "bail") {
        diagnosePlayOutcome("bail", track, generation, !!resolved.src);
        return;
      }
      // Still no source after a fresh resolve while we're the current play — a
      // genuine failure. Throw into the catch so the error modal / failed-track UI
      // surfaces it instead of leaving playback stuck on a stale now-playing bar.
      if (decision === "fail") {
        diagnosePlayOutcome("fail", track, generation, !!resolved.src);
        throw new Error(CHAIN_EXHAUSTED_MESSAGE);
      }
      // Resolution may have discovered the real local file for a path-less /
      // remote track (e.g. a Home track-row that only carried title+artist).
      // Merge that metadata in so the session opens as the right media type and
      // the now-playing UI classifies it correctly via currentTrack.
      const playTrack = resolved.patch ? { ...track, ...resolved.patch } : track;
      handedToEngine = true;
      await playWithSrc(playTrack, resolved.src, source, resolved.engineSource ?? null);
    } catch (e) {
      // A newer play request has superseded this one — its outcome belongs to a
      // track that's no longer current. Discard it.
      if (!isCurrentPlayGeneration(generation, playGenerationRef.current)) return;
      console.error("Playback error:", e);
      // A session still open here belongs to the previous track (this one never
      // opened) — it would otherwise keep playing underneath the error modal.
      if (nativeSessionRef.current) {
        endNativeSession();
        nativeEngine.stop().catch(console.error);
      }
      setPlaying(false);
      setCurrentTrack(track);
      // Nothing loaded: the previous track's length doesn't describe this one.
      setDurationSecs(0);
      const message = e instanceof Error ? e.message : String(e);
      const stage: TrackFailureStage = handedToEngine
        ? "playback"
        : message === ENGINE_UNAVAILABLE_ERROR ? "engine" : "resolve";
      surfacePlaybackFailure(message, track, lastPlaySrcRef.current, stage);
    } finally {
      if (isCurrentPlayGeneration(generation, playGenerationRef.current)) {
        setLoadingTrack(null);
      }
    }
  }

  // Latest handlePlay / surfacePlaybackFailure for the once-mounted engine-event
  // subscriptions (the functions are recreated every render; the effect's
  // closure would go stale).
  const handlePlayRef = useRef(handlePlay);
  useAssignRef(handlePlayRef, handlePlay);

  function setPendingSeek(secs: number) {
    pendingSeekRef.current = secs;
  }

  async function playWithSrc(track: QueueTrack, src: string, source: "user" | "auto", engineSource: EngineSource | null) {
    const seekTo = pendingSeekRef.current;

    trackChangeSourceRef.current = source;
    setCurrentTrack(track);
    prefetchRequestedRef.current = false;
    setCurrentAssetUrl(src);
    // Recorded so the failure paths can probe the failing source's host
    // (state would be a stale closure there) — see surfacePlaybackFailure.
    lastPlaySrcRef.current = src;
    lastEngineSourceRef.current = engineSource;
    setPlaybackPosition(seekTo > 0 ? seekTo : 0);
    setDurationSecs(track.duration_secs ?? 0);
    clearStreamReadouts();
    // A session resuming on a replaced file (swapCurrentFile) keeps its
    // scrobble state; any other play starts fresh. Consumed either way.
    const resumed = resumeScrobbleRef.current?.key === track.key ? resumeScrobbleRef.current : null;
    resumeScrobbleRef.current = null;
    resetScrobble(resumed ?? undefined);
    playStartedAtRef.current = resumed?.startedAt ?? Math.floor(Date.now() / 1000);
    pendingSeekRef.current = 0;

    const isVideo = isVideoTrack(track);
    if (!useNativeEngineRef.current) throw new Error(ENGINE_UNAVAILABLE_ERROR);
    if (!engineSource) throw new Error(UNPLAYABLE_SOURCE_ERROR);
    if (isVideo && !useNativeVideoRef.current) throw new Error(VIDEO_UNAVAILABLE_ERROR);

    // Opening the track replaces whatever the engine held — the previous
    // track, or a clip.
    takeEngineFromClip();
    nativePreloadedRef.current = null;
    nativeFadingRef.current = false;
    nativeLastPositionRef.current = seekTo > 0 ? seekTo : 0;
    nativeSessionRef.current = { key: track.key, track };
    resetNativeVideoPresentation();
    try {
      await nativeEngine.play({
        source: engineSource,
        trackKey: track.key,
        seekSecs: seekTo > 0 ? seekTo : null,
        volume: volumeRef.current,
        muted: mutedRef.current,
        video: isVideo,
      });
    } catch (e) {
      // The play command itself was refused (not a decode failure, which
      // arrives as engine-error). Only this session's own failure is ours to
      // clear — a newer play may already have replaced it.
      if (nativeSessionRef.current?.key === track.key) endNativeSession();
      throw e;
    }
    setPlaying(true);
    setNativeVideoActive(isVideo);
  }

  function handlePause() {
    // Open session: the engine owns play/pause. Optimistic UI flip;
    // engine-state reconciles.
    if (nativeSessionRef.current) {
      const shouldPause = playing;
      setPlaying(!shouldPause);
      nativeEngine.setPaused(shouldPause).catch((e) => {
        console.error("Pause toggle failed:", e);
        setPlaying(shouldPause);
      });
      return;
    }
    // Nothing open in the engine (restored at launch, cued by loadPaused,
    // handed over to a clip, or after an error): a play opens the track,
    // starting where pendingSeekRef says.
    if (currentTrack) handlePlay(currentTrack);
  }

  /**
   * Make `track` the current one WITHOUT starting it, cued to `positionSecs`.
   *
   * The gap this fills: every existing route to a different track plays it.
   * That is right for a click in the queue and wrong for anything that places a
   * playhead — a turntable visualizer moving its tonearm on a paused deck, most
   * obviously, which could otherwise only change track by starting the music and
   * then stopping it again, blipping a fraction of a second of audio each time.
   *
   * "Loaded but not open" is not a new state to the app: a restored track sits
   * in exactly it on every launch, and `handlePause` turns the next play into a
   * full `handlePlay` when no session is open. So this closes the session —
   * leaving it open would let the next press resume the OLD track.
   *
   * The position rides on `pendingSeekRef`, so the eventual play starts where
   * the needle was put rather than at zero.
   */
  function loadPaused(track: QueueTrack, positionSecs = 0) {
    invalidatePreload();
    if (nativeSessionRef.current) {
      endNativeSession();
      nativeEngine.stop().catch(console.error);
    }
    setPlaying(false);
    // NOT stopped any more. `stopped` means "no position — send the arm home",
    // and a track loaded at a position is the opposite of that. It self-clears on
    // the rising edge of `playing`, which a load deliberately never produces, so
    // without this it could only be cleared by playback actually resuming.
    //
    // That is what made cueing a finished queue look broken: the queue ends,
    // `handleStop` sets this, the visualizer drops its needle somewhere and the
    // load lands correctly — and the surface still reads "stopped", so a deck
    // parks its arm again over a track it has just been told is current and
    // cued. Launch already agrees: a restored track sits in exactly this
    // loaded-but-never-played state with `stopped` false.
    setStopped(false);
    setCurrentTrack(track);
    setCurrentAssetUrl(null);
    setPendingSeek(Math.max(0, positionSecs));
    setPlaybackPosition(Math.max(0, positionSecs));
  }

  /**
   * Replace the file under the track that is playing (the in-app replace).
   * The player lets go of the file first — the engine is stopped and awaited,
   * since on Windows an open handle makes the swap fail — then `apply` runs,
   * and the same session resumes: same key, same position, playing only if it
   * was, and the scrobble state carried over, so the resumed track is neither
   * announced as a new play nor counted twice. `next` maps apply's result to
   * the track to resume (the new file); when apply throws, the original track
   * resumes and the error is rethrown.
   */
  async function swapCurrentFile<T>(apply: () => Promise<T>, next: (result: T) => QueueTrack): Promise<T> {
    const track = currentTrackRef.current;
    if (!track) return apply();
    const position = getPlaybackPosition();
    const wasPlaying = playingRef.current;
    resumeScrobbleRef.current = { key: track.key, crossed: scrobbledRef.current, accepted: scrobbleAcceptedRef.current, startedAt: playStartedAtRef.current };
    invalidatePreload();
    if (nativeSessionRef.current) {
      endNativeSession();
      await nativeEngine.stop().catch((e) => console.error("Failed to stop the engine before a file swap:", e));
    }
    setLoadingTrack(track);
    let resumeWith = track;
    try {
      const result = await apply();
      resumeWith = { ...next(result), key: track.key };
      return result;
    } finally {
      setLoadingTrack(null);
      if (wasPlaying) {
        pendingSeekRef.current = position;
        handlePlay(resumeWith, "auto").catch((e) => console.error("Failed to resume after a file swap:", e));
      } else {
        loadPaused(resumeWith, position);
      }
    }
  }

  function handleStop() {
    invalidatePreload();
    takeEngineFromClip();
    if (nativeSessionRef.current) endNativeSession();
    nativeEngine.stop().catch(console.error);
    pendingSeekRef.current = 0;
    setPlaying(false);
    setStopped(true);
    setPlaybackPosition(0);
    setCurrentAssetUrl(null);
  }

  // --- Clips ----------------------------------------------------------------
  // A short piece of audio played outside the queue (the Music Quiz's
  // snippets). The engine is one shared resource, so a clip takes it over: the
  // main session is closed first, keeping its place, and the next main play
  // reopens the track where it stood. Clip keys carry CLIP_KEY_PREFIX, so the
  // main session's event handlers ignore everything a clip reports; the caller
  // subscribes to the `engine-*` events for the key it gets back.

  /** Hand the engine over: close the main session, keeping its place. */
  function yieldEngine() {
    invalidatePreload();
    if (nativeSessionRef.current) {
      pendingSeekRef.current = nativeLastPositionRef.current;
      endNativeSession();
    }
    setPlaying(false);
  }

  /** A main play or Stop is taking the engine: forget the clip and tell its
   *  owner, whose `engine-*` events end here. */
  function takeEngineFromClip() {
    if (!clipKeyRef.current) return;
    const lost = clipLostRef.current;
    clipKeyRef.current = null;
    clipLostRef.current = null;
    lost?.();
  }

  /** Play a clip from `source`, starting at `seekSecs`. `key` is what its
   *  `engine-*` events carry — returned at once, since they can arrive before
   *  `started` settles. `onLost` runs if a main play or Stop takes the engine
   *  before the clip is stopped (not when a newer clip replaces it). */
  function playClip(
    source: EngineSource,
    seekSecs = 0,
    opts: { onLost?: () => void } = {},
  ): { key: string; started: Promise<void> } {
    const key = `${CLIP_KEY_PREFIX}${++clipSeqRef.current}`;
    if (!useNativeEngineRef.current) return { key, started: Promise.reject(new Error(ENGINE_UNAVAILABLE_ERROR)) };
    // A main play still resolving (a slow yt-dlp lookup) was asked for before
    // this clip: retire it, or it would land on top of the clip seconds later.
    // Its handlePlay sees the newer generation and bails without an error.
    playGenerationRef.current++;
    setLoadingTrack(null);
    yieldEngine();
    clipKeyRef.current = key;
    clipLostRef.current = opts.onLost ?? null;
    const started = nativeEngine.play({
      source,
      trackKey: key,
      seekSecs: seekSecs > 0 ? seekSecs : null,
      volume: volumeRef.current,
      muted: mutedRef.current,
      video: false,
    });
    return { key, started };
  }

  /** Move a playing clip's position. No-op once the clip lost the engine. */
  function seekClip(key: string, secs: number) {
    if (clipKeyRef.current !== key) return;
    nativeEngine.seek(secs).catch((e) => console.error("Failed to seek the clip:", e));
  }

  /** Stop a clip. No-op once the clip lost the engine (a main play took it). */
  function stopClip(key: string) {
    if (clipKeyRef.current !== key) return;
    clipKeyRef.current = null;
    clipLostRef.current = null;
    nativeEngine.stop().catch((e) => console.error("Failed to stop the clip:", e));
  }

  // Surface a playback failure to the user. The base message shows immediately,
  // then the real cause is probed and the message upgraded when the content
  // isn't the actual problem (the engine reports a failed fetch and a missing
  // file as load failures, see playbackErrors.ts): remote tracks probe the
  // network for a connectivity error; local tracks probe the disk for a missing
  // file. The functional upgrade only replaces the exact base message, so it
  // never reopens a dismissed modal or clobbers a newer failure.
  function surfacePlaybackFailure(
    base: string,
    track: QueueTrack | null,
    src: string | null,
    stage: TrackFailureStage,
    engine?: { engineError: string; tries: number },
  ) {
    // The queue row keeps saying this after the toast or modal is gone — and a
    // click on it explains it (playback/trackFailures.ts).
    const recordFailure = (summary: string) => {
      if (!track) return;
      playbackOutcomeRef?.current?.failed(track.key, { stage, summary, engineError: engine?.engineError, tries: engine?.tries });
    };
    // The probes below answer seconds later. By then the user may have played
    // again (Try again, another track) — and that play may already have started
    // (clearing this record) or failed afresh (writing a newer one). Either
    // way the refinement no longer describes the row, so it must not land.
    const generation = playGenerationRef.current;
    const recordRefined = (summary: string) => {
      if (playGenerationRef.current !== generation) return;
      recordFailure(summary);
    };
    if (track) {
      if (startedReportedKeyRef.current === track.key) startedReportedKeyRef.current = null;
      recordFailure(base);
    }
    // Anonymous reliability signal: playback failed. Coarse class only — never
    // the error text, title, or path. `reason` is the original two-way split
    // (dashboards key on it); the bucketed `error_kind` is the finer breakdown
    // of the same failure. Fired for BOTH surfaces below — an auto-skipped
    // failure is still a failure.
    trackTelemetry("playback_error", {
      source: sourceClass(track?.path ?? null),
      reason: isFormatPlaybackError(base) ? "format" : "other",
      error_kind: classifyErrorKind(base),
    });
    // A track the QUEUE advanced to (playlist progression, gapless handoff —
    // not a user click) skips straight to the next track instead of stopping
    // the music behind the modal's 15s countdown. The user still sees it: App's
    // handler raises a toast, and the failure recorded above keeps its
    // "Couldn't play · …" note on the queue row. The streak cap is the circuit
    // breaker — past it the modal (whose countdown still advances, just slowly)
    // takes over, so a fully dead queue in repeat-all can't spin forever.
    const intent =
      track && playIntentRef.current?.key === track.key ? playIntentRef.current.source : "user";
    const autoSkip = onAutoSkipFailureRef.current;
    if (track && autoSkip && shouldAutoSkipFailure(intent, autoSkipStreakRef.current)) {
      autoSkipStreakRef.current += 1;
      logPlayback(
        `Auto-skipping "${track.title}" after playback failure (${autoSkipStreakRef.current}/${MAX_CONSECUTIVE_AUTO_SKIPS}): ${base}`,
      );
      autoSkip(track, base);
      return;
    }
    setPlaybackError(base);
    setFailedTrack(track);
    setPlaying(false);
    if (!track) return;
    // A mixtape track is a local file too — the archive — so it gets the same
    // "is it still there?" check rather than the network probe.
    const parsed = track.path ? parseUrlScheme(track.path) : null;
    if (parsed && (parsed.scheme === "file" || parsed.scheme === "mixtape")) {
      invoke<boolean>("file_exists", { path: parsed.path })
        .then((exists) => {
          const refined = describeLocalPlaybackFailure(base, exists);
          if (refined === base) return;
          setPlaybackError(prev => (prev === base ? refined : prev));
          recordRefined(refined);
        })
        .catch((e) => console.error("Failed to probe playback file existence:", e));
      return;
    }
    probeNetworkStatus(src).then((network) => {
      const refined = describePlaybackFailure(base, true, network);
      if (refined === base) return;
      setPlaybackError(prev => (prev === base ? refined : prev));
      recordRefined(refined);
    });
  }
  const surfacePlaybackFailureRef = useRef(surfacePlaybackFailure);
  useAssignRef(surfacePlaybackFailureRef, surfacePlaybackFailure);

  function clearPlaybackError() {
    setPlaybackError(null);
    setFailedTrack(null);
  }

  // Set while something else owns the volume (Bit-perfect mode routes it to
  // the output device's own level, or explains that it's fixed): `handleVolume`
  // hands the level over instead of changing the player's volume. Every volume
  // input — slider, wheel, arrow keys, the control API — routes through
  // `handleVolume`, so this one hook covers them all. App assigns it.
  const volumeOverrideRef = useRef<((level: number) => void) | null>(null);

  function handleVolume(level: number) {
    if (volumeOverrideRef.current) {
      volumeOverrideRef.current(level);
      return;
    }
    setVolume(level);
  }

  function toggleMute() {
    setMuted(m => !m);
  }

  function handleSeek(secs: number) {
    nativeLastPositionRef.current = secs;
    setPlaybackPosition(secs);
    if (nativeSessionRef.current) {
      nativeEngine.seek(secs).catch(console.error);
      return;
    }
    // No session open: the next play starts here.
    pendingSeekRef.current = secs;
  }

  // Relative seek (skip forward/back), clamped to the track.
  function seekBy(deltaSecs: number) {
    const current = nativeSessionRef.current ? nativeLastPositionRef.current : getPlaybackPosition();
    const target = durationSecs > 0
      ? Math.max(0, Math.min(durationSecs, current + deltaSecs))
      : Math.max(0, current + deltaSecs);
    handleSeek(target);
  }

  function toggleFullscreen() {
    // Video fullscreen = window fullscreen + the native-fs container pin (see
    // the nativeFullscreen state above). Audio fullscreen is App's overlay.
    if (!nativeVideoActive) return;
    const next = !nativeFullscreen;
    setNativeFullscreen(next);
    setWindowFullscreen(next);
  }

  return {
    currentTrack, setCurrentTrack,
    isEngineDecoding,
    trackChangeSourceRef,
    currentAssetUrl,
    playing, setPlaying, stopped, scrobbled,
    durationSecs, setDurationSecs,
    volume, setVolume,
    muted, setMuted, toggleMute,
    handlePlay, setPendingSeek, handlePause, handleStop, loadPaused, swapCurrentFile,
    handleVolume, volumeOverrideRef, handleSeek, seekBy,
    invalidatePreload,
    playClip, seekClip, stopClip,
    toggleFullscreen,
    nativeVideoActive,
    nativeVideoPresenting,
    nativeFullscreen,
    icyTitle,
    playbackError, failedTrack, clearPlaybackError,
    loadingTrack,
    playbackRate, setPlaybackRate,
    eqEnabled, setEqEnabled,
    eqMode, setEqMode,
    eqPreset, setEqPreset,
    eqGains, setEqGains,
    eqPreGainDb, setEqPreGainDb,
    eqBassDb, setEqBassDb,
    eqTrebleDb, setEqTrebleDb,
    eqClipProtection, setEqClipProtection,
    rgMode, setRgMode,
    rgPreampDb, setRgPreampDb,
    rgPreventClip, setRgPreventClip,
  };
}
