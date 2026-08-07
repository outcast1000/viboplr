// The plugin *visualizer* contract.
//
// A visualizer renders host state. It does not own it.
//
// That single rule is what makes this surface safe to hand to third parties:
// a visualizer is a pure function of (host state, user gesture), it holds no
// state anyone else depends on, and the only things it may write are the two
// gestures a playback visual naturally has — seek, and play a queue entry.
// Transport state (play/pause/volume), the queue's contents, and the library
// stay entirely with the host. A misbehaving visualizer can cost you a view;
// it can never cost you your music.
//
// Distinct from the declarative `PluginViewData` node union, which stays the
// preferred way to build anything that is a list, a form or a header — that's
// what makes plugin content look native. This is the escape hatch for genuine
// visuals, and it is deliberately narrow: the host owns the slots, the host
// owns the frame loop.

/**
 * Where a visualizer can be placed. The host owns these slots and the user
 * chooses which visualizer fills each one.
 */
export type PluginVisualizerPlacement =
  | "nowplaying"
  | "sidebar"
  | "queue-header"
  | "fullscreen"
  | "miniplayer";

export interface PluginVisualizerDescriptor {
  id: string;
  name: string;
  /** Slots this visualizer is willing to fill. */
  placements: PluginVisualizerPlacement[];
  /** Optional icon name for pickers. */
  icon?: string;
}

/**
 * Host-side view of a registered visualizer: the descriptor plus which plugin
 * it came from. Mirrors `PluginSearchProvider` / `PluginHomeShelf`.
 */
export interface PluginVisualizerRegistration extends PluginVisualizerDescriptor {
  pluginId: string;
}

export interface PluginVisualizerSize {
  readonly width: number;
  readonly height: number;
}

/**
 * A track as a visualizer sees it: display metadata only, with the artwork URL
 * already resolved into something a webview can load (the host owns
 * `convertFileSrc` and the image-cache chain).
 *
 * No DB ids: a visualizer has no business addressing library rows, and half the
 * things that reach a queue don't have one.
 */
export interface PluginVisualizerTrack {
  readonly title: string;
  readonly artistName: string | null;
  readonly albumTitle: string | null;
  /** Null is common and must be handled — streaming and metadata-only entries. */
  readonly durationSecs: number | null;
  readonly artUrl: string | null;
  /**
   * Per-second amplitude peaks (0..1), from the host's waveform cache.
   *
   * Present only for tracks that already have a cached waveform — the host reads
   * the cache and never analyses on a visualizer's behalf. Decoding a whole queue
   * to PCM would cost orders of magnitude more than drawing it, and analysis is
   * already restricted to local audio files under a size limit. So treat this as
   * an enrichment that arrives late or not at all: draw something sensible when
   * it's absent, and expect it to appear on a later frame (with a bumped
   * `queueRevision`) once a lookup lands.
   */
  readonly peaks?: readonly number[];
}

/**
 * The per-frame snapshot. Everything a visualizer needs to draw, delivered
 * together so it is internally consistent — `currentIndex` always indexes the
 * `queue` it arrived with, which removes a whole class of staleness bug that a
 * plugin assembling this itself from separate reads would have.
 */
export interface PluginVisualizerState {
  readonly playing: boolean;
  readonly positionSecs: number;
  /** Duration of the playing track, if known. */
  readonly durationSecs: number | null;
  readonly queue: readonly PluginVisualizerTrack[];
  /** Index into `queue`, or -1 when nothing is loaded. */
  readonly currentIndex: number;
  /**
   * Bumped when the PRESSING changes — the queue's contents or order, or
   * per-track data that arrived late (peaks resolving from the waveform cache).
   *
   * Lets a visualizer decide in O(1) whether to redo expensive per-queue work
   * (the deck re-lays out its bands and repaints its canvas) instead of
   * diffing the array on every frame.
   */
  readonly queueRevision: number;
  /**
   * Monotonic time in ms for animation. Host-supplied rather than read from
   * `performance.now()` so a visualizer stays deterministic under test.
   */
  readonly timeMs: number;
}

/**
 * The only writes a visualizer gets.
 *
 * `seek` is included on the principle that the host's own seek bar is a visual
 * that writes position — moving the playhead is part of *displaying* the
 * playhead. Transport state is not, and is absent on purpose.
 */
export interface PluginVisualizerActions {
  /** Seek within the currently playing track. Clamped by the host. */
  seek(positionSecs: number): void;
  /** Play the queue entry at `index`. Out-of-range is ignored by the host. */
  playQueueIndex(index: number): void;
  /**
   * Start or stop playback.
   *
   * A deliberate, narrow exception to "no transport" — added for the physical
   * control a deck already draws: a cue lever whose raised state IS the paused
   * state. Without it the lever can only lie, animating a lift while the music
   * keeps playing.
   *
   * Idempotent by design: pass the state you want, not a toggle. A visualizer
   * renders from a snapshot that may be a frame stale, and a toggle read against
   * a stale snapshot inverts. The host compares against live state and does
   * nothing when they already agree.
   *
   * This is still not general transport: there is no volume, no next/previous,
   * no queue mutation. Those stay with the host.
   */
  setPlaying(playing: boolean): void;
}

/**
 * What the host hands a visualizer at mount time.
 */
export interface PluginVisualizerHost {
  /**
   * Render target. A shadow root, which buys two things at once: the
   * visualizer's CSS can't leak out and the app's can't break it, while skin
   * tokens still arrive because CSS custom properties inherit through shadow
   * boundaries.
   */
  readonly root: ShadowRoot;
  /** Current slot size in CSS px. */
  readonly size: PluginVisualizerSize;
  /** Paint canvases at this ratio. Host-supplied so tests can fake it. */
  readonly pixelRatio: number;
  /** Which slot this instance is filling — the same visualizer may be sized
   *  and detailed differently in `miniplayer` vs `fullscreen`. */
  readonly placement: PluginVisualizerPlacement;
  /**
   * The user asked for reduced motion, so skip continuous animation.
   *
   * This has to be surfaced explicitly: the app's global
   * `prefers-reduced-motion` CSS guard does NOT reach inside a shadow root, and
   * it could never reach a canvas animation loop anyway. The host also adopts a
   * base sheet carrying that guard into every root, but anything animated in JS
   * must check this flag.
   */
  readonly reducedMotion: boolean;
  /** Resolve a skin token, e.g. `token("--accent")`. Re-read on skin change. */
  token(name: string): string;
  /** Adopt the app's design-system stylesheet into this root, so `.ds-*`
   *  classes work inside the isolated tree. */
  useDesignSystem(): void;
  /** Slot resized. Returns an unsubscriber. */
  onResize(handler: (size: PluginVisualizerSize) => void): () => void;
  /** Skin changed — re-read tokens and repaint anything colour-baked.
   *  Returns an unsubscriber. */
  onSkinChange(handler: () => void): () => void;
  readonly actions: PluginVisualizerActions;
}

/**
 * The visualizer itself.
 *
 * Note what is NOT here: any pointer/gesture hook. A visualizer owns a real DOM
 * subtree, so it attaches its own listeners and gets the full event model for
 * free — forwarding a synthetic subset through the contract would be strictly
 * less capable. (Follow the repo's drag rule inside it: manual mouse events,
 * never HTML5 drag-and-drop.)
 */
export interface PluginVisualizer {
  /** Build the DOM. May be async; `frame` is not called until it resolves. */
  mount(host: PluginVisualizerHost): void | Promise<void>;
  /**
   * Draw one frame.
   *
   * The HOST owns the animation loop, not the visualizer. That is what lets it
   * stop calling a visualizer that is off-screen or backgrounded, throttle for
   * reduced motion, and drive a deterministic sequence of states under test —
   * none of which is possible if every plugin runs its own
   * `requestAnimationFrame`.
   *
   * Must be cheap and allocation-light: it runs at display rate.
   */
  frame(state: PluginVisualizerState): void;
  /** Release listeners, timers and object URLs. The host discards the root. */
  destroy(): void;
}

/**
 * `api.visualizers` — mirrors the register/onFetch shape of `api.home` and
 * `api.search`: declare statically in the manifest, or register at runtime when
 * the set depends on user state.
 */
export interface PluginVisualizerAPI {
  register(descriptor: PluginVisualizerDescriptor): () => void;
  unregister(id: string): void;
  /** Supply the factory for a declared visualizer. One instance is created per
   *  occupied slot, so this must return a fresh object each call. */
  onMount(id: string, factory: () => PluginVisualizer): () => void;
}
