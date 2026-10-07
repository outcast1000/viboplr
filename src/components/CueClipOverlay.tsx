import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { cueCredit, type Cue } from "../utils/cueSheet";
import {
  activeClipCues, clipDim, clipFrame, cueColorCss, frameTransform, DEFAULT_BOX, DEFAULT_TEXT_SIZE,
} from "../utils/cueClip";
import { getPlaybackPosition, subscribePlaybackPosition } from "../playback/positionStore";
import { isReducedMotion } from "../utils/reducedMotion";
import "./CueClipOverlay.css";

/** The furthest the clock extrapolates past the last position tick. Ticks come
 *  ~4×/s; a gap longer than this means the engine stalled, and the frame
 *  should stall with it rather than run ahead of the audio. */
const MAX_EXTRAPOLATE_MS = 1000;
/** A tick that lands this little behind the extrapolated clock is jitter, not
 *  a seek — holding the frame avoids a visible backwards twitch. */
const JITTER_SECS = 0.3;

const ALIGN_ITEMS = { left: "flex-start", center: "center", right: "flex-end" } as const;
const JUSTIFY = { top: "flex-start", middle: "center", bottom: "flex-end" } as const;

function backgroundOf(cue: Cue): NonNullable<Cue["background"]> {
  if (cue.kind === "shape") return "solid";
  return cue.background ?? (cue.backgroundColor ? "solid" : "none");
}

function boxStyle(cue: Cue): CSSProperties {
  const box = cue.box ?? DEFAULT_BOX;
  const bg = backgroundOf(cue);
  const style: CSSProperties = {
    left: `${box.x}%`,
    top: `${box.y}%`,
    width: `${box.w}%`,
    height: `${box.h}%`,
    // Above the dim layer (z 1) whatever the layer, in layer order.
    zIndex: 20 + (cue.layer ?? 0),
    alignItems: ALIGN_ITEMS[cue.align ?? "center"],
    justifyContent: JUSTIFY[cue.valign ?? "middle"],
    textAlign: cue.align ?? "center",
    color: cueColorCss(cue.color, "var(--hero-text-primary)"),
    // --fit is the shrink fitText() applies when the text overflows its box.
    fontSize: `calc(${cue.size ?? DEFAULT_TEXT_SIZE}cqh * var(--fit, 1))`,
    fontWeight: cue.weight === "bold" ? 700 : undefined,
    fontStyle: (cue.italic ?? cue.kind === "quote") ? "italic" : undefined,
    textTransform: cue.case === "upper" ? "uppercase" : undefined,
    // Starts invisible; the frame loop sets the real value before the first
    // paint (layout effect), so nothing flashes at full opacity.
    opacity: 0,
  };
  // A shape has no text, so a `color` on it can only mean its fill — the
  // natural reading, and what an unaided assistant wrote in the self-test.
  // The save warns that backgroundColor is the documented field.
  const fill = cue.kind === "shape" ? cue.backgroundColor ?? cue.color : cue.backgroundColor;
  if (bg === "solid") style.background = cueColorCss(fill, "rgb(var(--scrim-rgb))");
  return style;
}

/** Smallest shrink fitText() applies — below this the text is unreadable and
 *  the box is simply too small; the overflow is clipped instead. */
const MIN_FIT = 0.2;

/** Shrink a text element's type until its text fits the box. The author sets
 *  a box and a size but cannot measure text, so `size` is a ceiling: a title
 *  that would wrap past its box comes out smaller instead of cut off. Measured
 *  on layout boxes, which transforms don't touch, so it's stable mid-motion.
 *  The not-yet-revealed half of a reveal keeps its space, so a typewriter line
 *  is fitted to its full text once, not re-fitted per letter. */
function fitText(box: HTMLDivElement): void {
  const block = box.querySelector<HTMLElement>(".np-clip-text-block");
  if (!block) return;
  box.style.setProperty("--fit", "1");
  const cs = getComputedStyle(box);
  const availW = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (availW <= 0 || availH <= 0) return;
  let fit = 1;
  // Wrapping makes the size→height relation non-linear, so converge in a few
  // proportional steps rather than one.
  for (let pass = 0; pass < 6; pass++) {
    const ratio = Math.min(availH / block.scrollHeight, availW / block.scrollWidth);
    if (ratio >= 0.995) break;
    fit = Math.max(MIN_FIT, fit * Math.min(ratio, 0.97));
    box.style.setProperty("--fit", fit.toFixed(3));
    if (fit === MIN_FIT) break;
  }
}

interface ElementNodes {
  box: HTMLDivElement | null;
  shown: HTMLSpanElement | null;
  hidden: HTMLSpanElement | null;
}

/** A clip sheet (`mode: "clip"`) playing over the whole Now Playing view.
 *  React renders only *which* elements are on screen; every per-frame value
 *  (position, opacity, reveal, dim) is written straight into the DOM from a
 *  frame loop, because a 60 Hz state update would re-render the subtree each
 *  frame. The loop runs only while playing — a paused clip redraws on
 *  position changes (seeks) and otherwise costs nothing. */
export function CueClipOverlay({ cues, playing, author, timingNote }: {
  cues: Cue[];
  playing: boolean;
  author?: string | null;
  timingNote?: string | null;
}) {
  const credit = cueCredit(author, timingNote);
  const [active, setActive] = useState<number[]>(() => activeClipCues(cues, getPlaybackPosition()));
  const activeKeyRef = useRef(active.join(","));
  const nodes = useRef(new Map<number, ElementNodes>());
  const dimRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clock = useRef({ pos: getPlaybackPosition(), at: performance.now(), shown: getPlaybackPosition() });
  const playingRef = useRef(playing);
  const reduced = useRef(isReducedMotion());
  const [failedImages, setFailedImages] = useState<ReadonlySet<number>>(() => new Set());

  const now = useCallback((): number => {
    const c = clock.current;
    let t = c.pos;
    if (playingRef.current) t += Math.min(performance.now() - c.at, MAX_EXTRAPOLATE_MS) / 1000;
    if (playingRef.current && t < c.shown && c.shown - t < JITTER_SECS) t = c.shown;
    c.shown = t;
    return t;
  }, []);

  const draw = useCallback(() => {
    const t = now();
    const ids = activeClipCues(cues, t);
    const key = ids.join(",");
    if (key !== activeKeyRef.current) {
      activeKeyRef.current = key;
      setActive(ids); // the layout effect below draws the new set
    }
    for (const i of ids) {
      const n = nodes.current.get(i);
      if (!n?.box) continue;
      const f = clipFrame(cues[i], t, reduced.current);
      n.box.style.opacity = f.opacity.toFixed(3);
      n.box.style.transform = frameTransform(f);
      n.box.style.filter = f.blur > 0.05 ? `blur(${f.blur.toFixed(1)}px)` : "";
      if (n.shown && n.hidden) {
        const text = cues[i].text ?? "";
        let cut = text.length;
        if (f.revealChars !== null) cut = f.revealChars;
        else if (f.revealWords !== null) {
          // Cut after the Nth word, keeping the original spacing.
          const m = text.match(new RegExp(`^\\s*(?:\\S+\\s*){0,${f.revealWords}}`));
          cut = f.revealWords === 0 ? 0 : (m?.[0].trimEnd().length ?? text.length);
        }
        const shown = text.slice(0, cut);
        if (n.shown.textContent !== shown) {
          n.shown.textContent = shown;
          n.hidden.textContent = text.slice(cut);
        }
      }
    }
    if (dimRef.current) dimRef.current.style.opacity = clipDim(cues, t).toFixed(3);
  }, [cues, now]);

  // Position ticks re-anchor the clock; while paused they are also the only
  // thing that redraws (a seek on a paused clip).
  useEffect(() => subscribePlaybackPosition(() => {
    const pos = getPlaybackPosition();
    clock.current = { ...clock.current, pos, at: performance.now() };
    if (!playingRef.current || Math.abs(pos - clock.current.shown) > JITTER_SECS) clock.current.shown = pos;
    if (!playingRef.current) draw();
  }), [draw]);

  useEffect(() => {
    playingRef.current = playing;
    clock.current = { ...clock.current, pos: getPlaybackPosition(), at: performance.now() };
    if (!playing) { draw(); return; }
    let id = 0;
    const loop = () => {
      if (!document.hidden) draw();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [playing, draw]);

  // A newly mounted element gets its frame — and its text fitted — before the
  // browser paints it. draw() first: it is what fills the text spans.
  useLayoutEffect(() => {
    draw();
    for (const i of active) {
      const box = nodes.current.get(i)?.box;
      if (box) fitText(box);
    }
  }, [active, draw]);

  // Wrapping changes with the view's shape, so a resize (window, fullscreen,
  // queue panel) refits whatever is on screen.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => {
      for (const n of nodes.current.values()) if (n.box) fitText(n.box);
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  const bind = (i: number, part: keyof ElementNodes) => (el: HTMLElement | null) => {
    const n = nodes.current.get(i) ?? { box: null, shown: null, hidden: null };
    (n[part] as HTMLElement | null) = el;
    if (!n.box && !n.shown && !n.hidden) nodes.current.delete(i);
    else nodes.current.set(i, n);
  };

  return (
    <div ref={rootRef} className="np-clip" aria-live="polite">
      <div ref={dimRef} className="np-clip-dim" style={{ opacity: 0 }} />
      {active.map((i) => {
        const cue = cues[i];
        const bg = backgroundOf(cue);
        const shadow = cue.shadow ?? bg === "none";
        return (
          <div
            key={i}
            ref={bind(i, "box")}
            className={`np-clip-el np-clip-el--${cue.kind} np-clip-bg--${bg}${shadow ? " np-clip-el--shadow" : ""}`}
            style={boxStyle(cue)}
          >
            {cue.kind === "image" && cue.imageUrl && !failedImages.has(i) && (
              <img
                className="np-clip-image"
                src={cue.imageUrl}
                alt={cue.caption ?? ""}
                referrerPolicy="no-referrer"
                style={{ objectFit: cue.fit ?? "cover" }}
                onError={() => setFailedImages((s) => new Set(s).add(i))}
              />
            )}
            {cue.kind !== "shape" && (cue.label || cue.text || (cue.kind !== "image" && cue.caption)) && (
              <div className="np-clip-text-block">
                {cue.label && <div className="np-clip-label">{cue.label}</div>}
                {cue.text && (
                  <div className="np-clip-text">
                    {cue.kind === "quote" && "“"}
                    {/* Both halves are filled by the frame loop, never by React, so a
                        reveal can rewrite them without fighting reconciliation. */}
                    <span ref={bind(i, "shown")} />
                    <span ref={bind(i, "hidden")} className="np-clip-unrevealed" />
                    {cue.kind === "quote" && "”"}
                  </div>
                )}
                {cue.caption && cue.kind !== "image" && <div className="np-clip-caption">{cue.caption}</div>}
              </div>
            )}
            {cue.kind === "image" && cue.caption && <div className="np-clip-image-caption">{cue.caption}</div>}
          </div>
        );
      })}
      {credit && active.length > 0 && <div className="np-clip-source" title={credit.title}>{credit.text}</div>}
    </div>
  );
}
