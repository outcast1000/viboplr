import { useEffect, useInsertionEffect, useRef } from "react";
import type {
  PluginVisualizer,
  PluginVisualizerHost,
  PluginVisualizerPlacement,
  PluginVisualizerSize,
  PluginVisualizerState,
  PluginVisualizerTrack,
} from "../types/pluginVisualizer";
import type { QueueTrack } from "../types";
import { resolveImageSrc } from "../utils/resolveImageUrl";
import { getPlaybackPosition } from "../playback/positionStore";
import { invoke } from "@tauri-apps/api/core";
import { waveformKey } from "../hooks/useWaveform";
import dsCss from "../design-system.css?raw";
import { useAssignRef } from "../hooks/useLatestRef";
import "./VisualizerSlot.css";

/**
 * Base sheet adopted into every visualizer's shadow root.
 *
 * The app's global `prefers-reduced-motion` guard lives in base.css and does
 * NOT cross a shadow boundary, so without this a visualizer would keep
 * animating for a user who asked it not to. `PluginVisualizerHost.reducedMotion`
 * covers the other half — anything animated in JS or on a canvas, which CSS
 * can't reach at all.
 */
const BASE_SHEET = `
:host { display: block; width: 100%; height: 100%; }
* { box-sizing: border-box; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}
`;

/** Adopt a stylesheet, falling back to a <style> tag where constructable
 *  stylesheets aren't available. */
function addSheet(root: ShadowRoot, css: string) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  } catch {
    // Older WebKit: no constructable stylesheets. A <style> element is
    // equivalent here — it just can't be shared between roots.
    const el = document.createElement("style");
    el.textContent = css;
    root.append(el);
  }
}

export function toVisualizerTrack(
  t: QueueTrack,
  peaks?: readonly number[],
): PluginVisualizerTrack {
  return {
    title: t.title ?? "",
    artistName: t.artist_name ?? null,
    albumTitle: t.album_title ?? null,
    durationSecs: typeof t.duration_secs === "number" ? t.duration_secs : null,
    // Resolved here, not in the plugin: convertFileSrc and the image-cache
    // chain are host machinery.
    artUrl: resolveImageSrc(t.image_url ?? null),
    peaks,
  };
}

/**
 * Read cached peaks for a queue, so a visualizer can texture each track's own
 * region with its real audio.
 *
 * CACHE READ ONLY — `get_cached_waveform` never analyses. That restraint is the
 * whole design: analysis decodes a file to PCM in the webview and is deliberately
 * limited to local audio under a size cap (see useWaveform), so doing it per queue
 * entry would be orders of magnitude more expensive than drawing the result. Every
 * track the user has actually played is already cached and comes back free;
 * everything else is simply absent, which the contract tells visualizers to expect.
 *
 * Deduplicated by cache key, because a queue can hold the same song twice and one
 * lookup should serve both.
 */
async function loadCachedPeaks(
  queue: QueueTrack[],
  into: Map<string, number[] | null>,
): Promise<boolean> {
  const wanted = new Set<string>();
  for (const t of queue) {
    if (!t.title) continue;
    const key = waveformKey(t.artist_name ?? null, t.title, t.duration_secs ?? null);
    if (!into.has(key)) wanted.add(key);
  }
  if (wanted.size === 0) return false;

  let gained = false;
  await Promise.all(
    [...wanted].map(async (key) => {
      try {
        const cached = await invoke<{ peaks?: number[] } | null>("get_cached_waveform", { key });
        const peaks = cached?.peaks?.length ? cached.peaks : null;
        into.set(key, peaks);
        if (peaks) gained = true;
      } catch {
        // A miss and a read error are the same outcome here: no texture for that
        // band. Recorded as null so we don't ask again for this queue.
        into.set(key, null);
      }
    }),
  );
  return gained;
}

export interface VisualizerSlotProps {
  placement: PluginVisualizerPlacement;
  /** `pluginId:visualizerId`, or null for "no visualizer in this slot". */
  selection: string | null;
  createVisualizer: (pluginId: string, visualizerId: string) => PluginVisualizer | null;
  queue: QueueTrack[];
  currentIndex: number;
  playing: boolean;
  /** Playback was stopped rather than paused — see `PluginVisualizerState.stopped`. */
  stopped?: boolean;
  durationSecs: number | null;
  /**
   * Art for the playing track, already resolved through the host's image chain.
   *
   * `QueueTrack.image_url` is only populated for plugin-supplied or stamped
   * entries — an ordinary library track has none, and the app resolves its art
   * asynchronously by album/artist name (the same chain the queue rows use). So
   * without this the label would be blank for most tracks. Resolved in App
   * during render, where the cache lives, and picked up on the next frame when
   * the async lookup lands.
   */
  currentArtUrl?: string | null;
  onSeek: (secs: number) => void;
  onPlayQueueIndex: (index: number) => void;
  /** Make an entry current without starting it — see
   *  `PluginVisualizerActions.loadQueueIndex`. Omit and the action is absent. */
  onLoadQueueIndex?: (index: number, positionSecs?: number) => void;
  /** Start/stop playback — see `PluginVisualizerActions.setPlaying`. */
  onSetPlaying: (playing: boolean) => void;
  /** Current playback rate; 1 is normal. Surfaced in the frame state so a deck's
   *  speed selector can show which speed is lit. */
  rate?: number;
  /** Set the playback rate — see `PluginVisualizerActions.setRate`. Clamped here
   *  before it reaches the host. */
  onSetRate?: (rate: number) => void;
  /**
   * App volume (0..1) and mute, mirrored onto the visualizer audio bus so a
   * visualizer's own noises move with the transport the user is operating.
   *
   * Omit both and the bus sits at full — correct for a caller that has no
   * volume of its own to speak for, wrong for the now-playing surfaces, which
   * do.
   */
  volume?: number;
  muted?: boolean;
  className?: string;
}

/** Slowest and fastest a visualizer may ask for. 78rpm on a 33 pressing is
 *  2.34x, which is the fastest thing a deck can honestly want. */
export const MIN_VISUALIZER_RATE = 0.25;
export const MAX_VISUALIZER_RATE = 4;

/**
 * Frames per second the host will drive a visualizer at, at most.
 *
 * A CEILING FOR PORTABILITY, NOT A WIN ON MACOS — and the difference was measured,
 * so don't re-justify it as a saving. `requestAnimationFrame` is documented as
 * firing at the display's refresh rate, but WKWebView on macOS drives it at 60Hz
 * even on a 120Hz ProMotion panel: instrumented in the running app, raw rAF came
 * back at 60.0Hz and the gate below passed 60.0 of those per second, so on that
 * machine this constant skips nothing. Alternating A/B runs (deck on screen,
 * playing, everything else held identical) put capped and uncapped within ~0.7
 * CPU-s/min of each other, which is the noise floor of that rig.
 *
 * It stays because the platforms differ and the loop is the only place that can
 * bound them: a webview that does honour a high-refresh display (WebView2 on a
 * 120/144Hz monitor) would otherwise hand every visualizer 2-2.4x the frames for
 * a picture nobody can tell apart. 60 is the ceiling of what reads as smooth for
 * the motion these slots hold — a turning platter, a tracking arm, a meter.
 *
 * Capped centrally rather than left to each plugin for the same reason the loop
 * itself lives here: a visualizer cannot be trusted to throttle itself, and one
 * that tried would have no way to know what else is on screen.
 *
 * For scale, from the same rig: the vinyl deck's whole animation is ~1 CPU-s/min
 * (~1.7% of one core) at 60fps, against ~7.8 CPU-s/min for the rest of the Now
 * Playing view with the deck frozen. A visualizer's frame rate is not where that
 * screen's cost lives.
 */
export const VISUALIZER_TARGET_FPS = 60;

const FRAME_BUDGET_MS = 1000 / VISUALIZER_TARGET_FPS;

/**
 * Has enough time passed to draw again?
 *
 * **Deliberately lenient** — it draws once 75% of the budget has elapsed, not
 * strictly at it. A display whose interval doesn't divide the budget would
 * otherwise miss the deadline by a hair on every second frame and fall to *half*
 * the target: at 144Hz two frames are 13.9ms, which a strict 16.67ms test
 * rejects, so the third frame would carry it and the visual would run at 48fps
 * instead of 60. Erring toward drawing lands such a display just above the
 * target rather than well below it, and costs an exactly-120Hz panel nothing
 * (8.3ms is still short, 16.7ms still passes).
 *
 * `lastMs === null` is the first frame of a mount, and a backwards `timeMs` is a
 * new timeline (the loop resuming after the page was hidden) — both draw.
 */
export function shouldRenderFrame(
  timeMs: number,
  lastMs: number | null,
  budgetMs: number = FRAME_BUDGET_MS,
): boolean {
  if (lastMs === null) return true;
  const elapsed = timeMs - lastMs;
  if (elapsed < 0) return true;
  return elapsed >= budgetMs * 0.75;
}

/**
 * The one audio device visualizers share, and the one node they may play into.
 *
 * MODULE-LEVEL, not per slot. An AudioContext is a real output device — browsers
 * cap how many can exist and each costs a hardware stream — and two slots can be
 * mounted at once (the fullscreen overlay is dropped while it's up precisely
 * because both would otherwise run). One device, one trim, every voice through
 * it.
 *
 * BUILT ON FIRST REQUEST, never at mount. A context constructed before any user
 * gesture starts `suspended` and plays nothing, and one constructed for a
 * visualizer that never makes a sound is a device opened for the sake of it —
 * which on some machines spins up an audio path that was asleep.
 */
let sharedAudio: { context: AudioContext; destination: GainNode } | null = null;

/** Last volume/mute the app told us, so a bus built later opens at the right
 *  level instead of at full and ducking a frame afterwards. */
let lastBusLevel = 1;

/**
 * How many visualizer slots are mounted, so a bus nobody is holding can be put
 * back to sleep.
 *
 * A running `AudioContext` is a live render thread waking every 128-sample
 * quantum — ~2.7ms at 48kHz — whether or not anything is connected to it. Since
 * the context is module-level and outlives every slot, one visit to Now Playing
 * with a visualizer that reads `host.audio` used to leave that thread awake for
 * the rest of the session, which on a laptop is heat for nothing.
 */
let mountedSlots = 0;

/** Pending idle suspend, cancelled if a slot mounts inside the grace window. */
let busIdleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Grace period before an unheld bus is suspended.
 *
 * Long enough to let a one-shot that was fired on the way out finish (a needle
 * drop, a transport click), and to cover a slot handover — leaving fullscreen
 * unmounts one instance and mounts the other, so the count legitimately touches
 * zero for a tick and a suspend/resume pair there would be an audible seam.
 */
const BUS_IDLE_SUSPEND_MS = 2000;

/** Claim the bus for a mounted slot. Never *builds* one — that stays on the
 *  first `host.audio` read, so a visualizer that only draws opens no device. */
function acquireAudioBus() {
  mountedSlots += 1;
  if (busIdleTimer !== null) {
    clearTimeout(busIdleTimer);
    busIdleTimer = null;
  }
  if (sharedAudio && sharedAudio.context.state === "suspended") {
    sharedAudio.context
      .resume()
      .catch((e) => console.error("Failed to resume the visualizer audio bus:", e));
  }
}

/**
 * Release a slot's claim, suspending the bus once the last one is gone.
 *
 * Suspended, not closed: a closed context can never be reused, so the next visit
 * would pay the device spin-up this is trying to avoid — and browsers cap how
 * many contexts may exist, which is why there is one to begin with.
 */
function releaseAudioBus() {
  mountedSlots = Math.max(0, mountedSlots - 1);
  if (mountedSlots > 0) return;
  if (busIdleTimer !== null) clearTimeout(busIdleTimer);
  busIdleTimer = setTimeout(() => {
    busIdleTimer = null;
    if (mountedSlots > 0 || !sharedAudio) return;
    if (sharedAudio.context.state !== "running") return;
    sharedAudio.context
      .suspend()
      .catch((e) => console.error("Failed to suspend the idle visualizer audio bus:", e));
  }, BUS_IDLE_SUSPEND_MS);
}

export function busGain(volume: number, muted: boolean): number {
  if (muted) return 0;
  return Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
}

/**
 * The shared bus, created on demand.
 *
 * Returns null if the platform has no Web Audio at all, which keeps the
 * capability honestly absent rather than throwing inside a plugin's mount.
 */
function getSharedAudio(): { context: AudioContext; destination: GainNode } | null {
  if (sharedAudio) return sharedAudio;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    const context = new Ctor();
    const destination = context.createGain();
    destination.gain.value = lastBusLevel;
    destination.connect(context.destination);
    sharedAudio = { context, destination };
    return sharedAudio;
  } catch (e) {
    console.error("Failed to create the visualizer audio bus:", e);
    return null;
  }
}

/**
 * Mirror the app's volume onto the bus.
 *
 * Load-bearing on the native mpv engine, which is the default: music leaves
 * through mpv and WebAudio leaves through the webview, so they are independent
 * outputs. Without this, muting the app would silence the music and leave a
 * deck clicking to itself.
 */
function setBusLevel(volume: number, muted: boolean) {
  lastBusLevel = busGain(volume, muted);
  if (!sharedAudio) return;
  const { context, destination } = sharedAudio;
  const t = context.currentTime;
  destination.gain.cancelScheduledValues(t);
  destination.gain.setValueAtTime(destination.gain.value, t);
  // Ramped, not stepped: a gain jump on a running noise bed is a click.
  destination.gain.linearRampToValueAtTime(lastBusLevel, t + 0.05);
}

/**
 * Clamp a rate a plugin asked for.
 *
 * Not a formality. Every other write in the contract is instantly visible and
 * trivially undone; a rate is audible, subtle and sticky, so this is the first
 * one that could really cost someone their music. A visualizer that asks for 0
 * (silence that looks like a hang), a negative, or NaN gets 1 instead of a dead
 * player.
 */
export function clampRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 1;
  return Math.min(MAX_VISUALIZER_RATE, Math.max(MIN_VISUALIZER_RATE, rate));
}

/**
 * Hosts one plugin visualizer.
 *
 * The host owns the animation loop and calls `frame(state)`. That's what makes
 * it possible to stop a visualizer that isn't on screen, honour reduced motion
 * centrally, and keep a runaway plugin from pinning a core — none of which works
 * if every plugin runs its own requestAnimationFrame.
 */
export function VisualizerSlot({
  placement,
  selection,
  createVisualizer,
  queue,
  currentIndex,
  playing,
  stopped = false,
  durationSecs,
  currentArtUrl,
  onSeek,
  onPlayQueueIndex,
  onLoadQueueIndex,
  onSetPlaying,
  rate = 1,
  onSetRate,
  volume = 1,
  muted = false,
  className,
}: VisualizerSlotProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Straight through on every render rather than in an effect: this is a plain
  // assignment onto an audio node, not React state, and an effect would land a
  // frame late — which on a mute is a frame of noise the user asked not to hear.
  setBusLevel(volume, muted);

  // Live values the frame loop reads without re-subscribing. The loop runs
  // outside React's render cycle on purpose: a 60fps setState would re-render
  // the whole Now Playing view.
  const liveRef = useRef({ queue, currentIndex, playing, stopped, durationSecs, currentArtUrl, rate });
  useAssignRef(liveRef, { queue, currentIndex, playing, stopped, durationSecs, currentArtUrl, rate });

  const actionsRef = useRef({ onSeek, onPlayQueueIndex, onLoadQueueIndex, onSetPlaying, onSetRate });
  useAssignRef(actionsRef, { onSeek, onPlayQueueIndex, onLoadQueueIndex, onSetPlaying, onSetRate });

  /**
   * `queueRevision` lets a visualizer decide in O(1) whether to redo per-queue
   * work. Bumped on array identity change, which `useQueue` only produces on a
   * real mutation.
   */
  const revisionRef = useRef(0);
  const lastQueueRef = useRef<QueueTrack[] | null>(null);
  // Bumped in an insertion effect rather than inline in the render body: the only
  // reader is the rAF frame loop below (plus the cached-peaks effect, which
  // already bumps it from an effect), and both run after commit — so a committed
  // write is observationally identical here, while a render-body write is one
  // React forbids (see hooks/useLatestRef.ts).
  useInsertionEffect(() => {
    if (lastQueueRef.current !== queue) {
      lastQueueRef.current = queue;
      revisionRef.current += 1;
    }
  });

  // Mapped tracks are memoised against the same identity so we're not
  // rebuilding the whole queue every frame.
  const mappedRef = useRef<{ src: QueueTrack[] | null; out: PluginVisualizerTrack[] }>({
    src: null,
    out: [],
  });

  /** Cached peaks by waveform key. `null` = looked up, nothing cached. */
  const peaksRef = useRef<Map<string, number[] | null>>(new Map());

  // Fetch what the cache already has for this queue. Async, so it lands on a
  // later frame; bumping the revision is what tells the visualizer to re-press
  // with the new texture rather than waiting for the next queue change.
  useEffect(() => {
    if (!selection || queue.length === 0) return;
    let cancelled = false;
    loadCachedPeaks(queue, peaksRef.current)
      .then((gained) => {
        if (cancelled || !gained) return;
        mappedRef.current = { src: null, out: [] }; // force a re-map
        revisionRef.current += 1;
      })
      .catch((e) => console.error("Failed to read cached waveforms for visualizer:", e));
    return () => {
      cancelled = true;
    };
  }, [queue, selection]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !selection) return;

    const sep = selection.indexOf(":");
    if (sep <= 0) return;
    const pluginId = selection.slice(0, sep);
    const visualizerId = selection.slice(sep + 1);

    const visualizer = createVisualizer(pluginId, visualizerId);
    if (!visualizer) return;

    // A fresh host element per mount, so a torn-down visualizer's DOM can never
    // linger (a shadow root cannot be detached once attached).
    const mountEl = document.createElement("div");
    mountEl.className = "visualizer-mount";
    container.append(mountEl);
    const root = mountEl.attachShadow({ mode: "open" });
    addSheet(root, BASE_SHEET);

    let designSystemAdopted = false;
    const resizeHandlers: ((s: PluginVisualizerSize) => void)[] = [];
    const skinHandlers: (() => void)[] = [];
    let size: PluginVisualizerSize = {
      width: container.clientWidth,
      height: container.clientHeight,
    };

    const reducedMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
      document.documentElement.hasAttribute("data-reduce-motion");

    const host: PluginVisualizerHost = {
      root,
      get size() {
        return size;
      },
      pixelRatio: window.devicePixelRatio || 1,
      placement,
      reducedMotion,
      token: (name) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
      useDesignSystem: () => {
        if (designSystemAdopted) return;
        designSystemAdopted = true;
        addSheet(root, dsCss);
      },
      onResize: (h) => {
        resizeHandlers.push(h);
        return () => {
          const i = resizeHandlers.indexOf(h);
          if (i >= 0) resizeHandlers.splice(i, 1);
        };
      },
      onSkinChange: (h) => {
        skinHandlers.push(h);
        return () => {
          const i = skinHandlers.indexOf(h);
          if (i >= 0) skinHandlers.splice(i, 1);
        };
      },
      // A GETTER, so the device is opened by the first visualizer that actually
      // asks for it and never by one that only draws. `host.audio` itself is
      // always present here; what it exposes is built on read.
      get audio() {
        const bus = getSharedAudio();
        if (!bus) return undefined;
        // An autoplay policy can leave the context suspended however it was
        // built. Resuming on each read is cheap when it is already running, and
        // a visualizer only reads this from inside a mount or a gesture.
        if (bus.context.state === "suspended") {
          bus.context.resume().catch((e) => console.error("Failed to resume the visualizer audio bus:", e));
        }
        return { context: bus.context, destination: bus.destination };
      },
      actions: {
        seek: (secs) => actionsRef.current.onSeek(secs),
        playQueueIndex: (index) => actionsRef.current.onPlayQueueIndex(index),
        // Present only when the host supplied a handler, so a visualizer's
        // `typeof host.actions.loadQueueIndex === "function"` check is the truth
        // about whether this app can do it — the contract marks it optional for
        // exactly that reason.
        ...(onLoadQueueIndex
          ? {
              loadQueueIndex: (index: number, positionSecs?: number) =>
                actionsRef.current.onLoadQueueIndex?.(index, positionSecs),
            }
          : {}),
        setPlaying: (playing) => actionsRef.current.onSetPlaying(playing),
        setRate: (r) => actionsRef.current.onSetRate?.(clampRate(r)),
      },
    };

    const ro = new ResizeObserver(() => {
      const next = { width: container.clientWidth, height: container.clientHeight };
      if (next.width === size.width && next.height === size.height) return;
      size = next;
      for (const h of resizeHandlers) {
        try {
          h(next);
        } catch (e) {
          console.error(`[plugin:${pluginId}] visualizer resize handler failed:`, e);
        }
      }
    });
    ro.observe(container);

    // Repaint anything colour-baked when the skin changes. The skin is injected
    // as one <style id="viboplr-skin"> element, so observing it is exact and
    // cheap — far better than polling computed styles.
    const skinEl = document.getElementById("viboplr-skin");
    const mo = skinEl
      ? new MutationObserver(() => {
          for (const h of skinHandlers) {
            try {
              h();
            } catch (e) {
              console.error(`[plugin:${pluginId}] visualizer skin handler failed:`, e);
            }
          }
        })
      : null;
    mo?.observe(skinEl!, { childList: true, characterData: true, subtree: true });

    // Only run while actually on screen. An off-screen visualizer that keeps
    // painting is pure battery cost.
    let onScreen = true;
    const io = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
      },
      { threshold: 0 },
    );
    io.observe(container);

    let raf = 0;
    let alive = true;
    let framesFailed = 0;
    /** Last frame actually handed to the plugin — see `shouldRenderFrame`. */
    let lastFrameMs: number | null = null;

    const tick = (timeMs: number) => {
      if (!alive) return;
      raf = requestAnimationFrame(tick);
      if (!onScreen || document.hidden) return;
      // A gap — off-screen, hidden, a slow frame — is always over budget, so the
      // frame that brings the visualizer back is never the one withheld.
      if (!shouldRenderFrame(timeMs, lastFrameMs)) return;
      lastFrameMs = timeMs;

      const live = liveRef.current;
      if (mappedRef.current.src !== live.queue) {
        const peaks = peaksRef.current;
        mappedRef.current = {
          src: live.queue,
          out: live.queue.map((t) =>
            toVisualizerTrack(
              t,
              t.title
                ? peaks.get(waveformKey(t.artist_name ?? null, t.title, t.duration_secs ?? null)) ??
                    undefined
                : undefined,
            ),
          ),
        };
      }
      // Overlay the host-resolved art onto the playing entry without disturbing
      // the memoised mapping (which is keyed on queue identity).
      let tracks = mappedRef.current.out;
      const cur = tracks[live.currentIndex];
      if (cur && live.currentArtUrl && cur.artUrl !== live.currentArtUrl) {
        tracks = tracks.slice();
        tracks[live.currentIndex] = { ...cur, artUrl: live.currentArtUrl };
        mappedRef.current.out = tracks;
      }

      const state: PluginVisualizerState = {
        playing: live.playing,
        // The contract promises these are never both true. Enforced here rather
        // than trusted from the host: `stopped` self-clears via an effect, so it
        // trails `playing` by a render on resume, and a visualizer branching on
        // stopped-first would draw one frame of the wrong state every time.
        stopped: live.stopped && !live.playing,
        positionSecs: getPlaybackPosition(),
        durationSecs: live.durationSecs,
        queue: tracks,
        currentIndex: live.currentIndex,
        queueRevision: revisionRef.current,
        timeMs,
        rate: live.rate,
      };
      try {
        visualizer.frame(state);
        framesFailed = 0;
      } catch (e) {
        // A visualizer that throws every frame would flood the console and
        // burn a core, so give up on it rather than letting it fail forever.
        console.error(`[plugin:${pluginId}] visualizer frame failed:`, e);
        if (++framesFailed >= 10) {
          console.error(`[plugin:${pluginId}] visualizer disabled after repeated frame errors`);
          alive = false;
          cancelAnimationFrame(raf);
        }
      }
    };

    let started = false;
    const start = () => {
      if (!alive || started) return;
      started = true;
      raf = requestAnimationFrame(tick);
    };

    // Before `mount`, which is where a visualizer that makes noise reads
    // `host.audio` — so a bus left suspended by the previous slot is awake by the
    // time the plugin takes its reference to it.
    acquireAudioBus();

    try {
      const maybe = visualizer.mount(host);
      if (maybe && typeof (maybe as Promise<void>).then === "function") {
        (maybe as Promise<void>).then(start).catch((e) => {
          console.error(`[plugin:${pluginId}] visualizer mount failed:`, e);
        });
      } else {
        start();
      }
    } catch (e) {
      console.error(`[plugin:${pluginId}] visualizer mount threw:`, e);
      alive = false;
    }

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      mo?.disconnect();
      try {
        visualizer.destroy();
      } catch (e) {
        console.error(`[plugin:${pluginId}] visualizer destroy failed:`, e);
      }
      mountEl.remove();
      // After `destroy`, so the plugin's own teardown ramps and stops still land
      // on a running context rather than being frozen mid-fade.
      releaseAudioBus();
    };
    // Re-mount only when the selected visualizer changes. Queue/transport
    // changes reach the running instance through refs and the frame loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, placement, createVisualizer]);

  if (!selection) return null;
  return (
    <div
      ref={containerRef}
      className={className ? `visualizer-slot ${className}` : "visualizer-slot"}
    />
  );
}
