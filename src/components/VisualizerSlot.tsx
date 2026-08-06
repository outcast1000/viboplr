import { useEffect, useRef } from "react";
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
import dsCss from "../design-system.css?raw";
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

export function toVisualizerTrack(t: QueueTrack): PluginVisualizerTrack {
  return {
    title: t.title ?? "",
    artistName: t.artist_name ?? null,
    albumTitle: t.album_title ?? null,
    durationSecs: typeof t.duration_secs === "number" ? t.duration_secs : null,
    // Resolved here, not in the plugin: convertFileSrc and the image-cache
    // chain are host machinery.
    artUrl: resolveImageSrc(t.image_url ?? null),
  };
}

export interface VisualizerSlotProps {
  placement: PluginVisualizerPlacement;
  /** `pluginId:visualizerId`, or null for "no visualizer in this slot". */
  selection: string | null;
  createVisualizer: (pluginId: string, visualizerId: string) => PluginVisualizer | null;
  queue: QueueTrack[];
  currentIndex: number;
  playing: boolean;
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
  className?: string;
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
  durationSecs,
  currentArtUrl,
  onSeek,
  onPlayQueueIndex,
  className,
}: VisualizerSlotProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Live values the frame loop reads without re-subscribing. The loop runs
  // outside React's render cycle on purpose: a 60fps setState would re-render
  // the whole Now Playing view.
  const liveRef = useRef({ queue, currentIndex, playing, durationSecs, currentArtUrl });
  liveRef.current = { queue, currentIndex, playing, durationSecs, currentArtUrl };

  const actionsRef = useRef({ onSeek, onPlayQueueIndex });
  actionsRef.current = { onSeek, onPlayQueueIndex };

  /**
   * `queueRevision` lets a visualizer decide in O(1) whether to redo per-queue
   * work. Bumped on array identity change, which `useQueue` only produces on a
   * real mutation.
   */
  const revisionRef = useRef(0);
  const lastQueueRef = useRef<QueueTrack[] | null>(null);
  if (lastQueueRef.current !== queue) {
    lastQueueRef.current = queue;
    revisionRef.current += 1;
  }

  // Mapped tracks are memoised against the same identity so we're not
  // rebuilding the whole queue every frame.
  const mappedRef = useRef<{ src: QueueTrack[] | null; out: PluginVisualizerTrack[] }>({
    src: null,
    out: [],
  });

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
      actions: {
        seek: (secs) => actionsRef.current.onSeek(secs),
        playQueueIndex: (index) => actionsRef.current.onPlayQueueIndex(index),
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

    const tick = (timeMs: number) => {
      if (!alive) return;
      raf = requestAnimationFrame(tick);
      if (!onScreen || document.hidden) return;

      const live = liveRef.current;
      if (mappedRef.current.src !== live.queue) {
        mappedRef.current = { src: live.queue, out: live.queue.map(toVisualizerTrack) };
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
        positionSecs: getPlaybackPosition(),
        durationSecs: live.durationSecs,
        queue: tracks,
        currentIndex: live.currentIndex,
        queueRevision: revisionRef.current,
        timeMs,
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
