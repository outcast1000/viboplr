// Styles for the deck, injected into the visualizer's shadow root.
//
// Every colour is a skin token. CSS custom properties inherit through a shadow
// boundary, so `var(--bg-primary)` here resolves to whatever skin the user has
// on, with no plumbing. The record body is derived from the skin rather than
// hardcoded black so a light skin tints it, and each derived value is exposed as
// an overridable `--vinyl-*` property.
//
// The canvas underneath paints black/white alpha ONLY (see surface.ts), which is
// why nothing here has to be kept in step with it and why a skin change needs no
// repaint.

export const DECK_CSS = `
:host { display: block; width: 100%; height: 100%; }
* { box-sizing: border-box; }

.deck {
  --vinyl-body: color-mix(in srgb, var(--bg-primary) 26%, #000);
  --vinyl-body-hi: color-mix(in srgb, var(--bg-primary) 46%, #000);
  --vinyl-sheen: #fff;
  --vinyl-platter: var(--bg-tertiary);
  --tilt: 0deg;
  --k: 1; /* deck size / 368 reference — see repress() */
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  perspective: 620px;
}

.platter {
  position: relative;
  border-radius: 50%;
  transform-style: preserve-3d;
  flex: 0 0 auto;
}
/* Tilt lives on an inner wrapper-free platter: rotateX composes with the crop's
   scale/translate already on this element. */
.deck { transform-style: preserve-3d; }
.platter { rotate: x var(--tilt); }

.body {
  position: absolute; inset: 0; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%,
    var(--vinyl-body-hi) 8%, var(--vinyl-body) 55%, var(--vinyl-body) 100%);
  box-shadow: 0 10px 26px -8px rgba(0,0,0,.7);
}
.spin { position: absolute; inset: 0; border-radius: 50%; transform-origin: 50% 50%; will-change: transform; }
canvas { position: absolute; inset: 0; border-radius: 50%; display: block; }

/* Anisotropic shimmer — a whisper of radial texture that turns WITH the grooves.
   Kept near-invisible on purpose: a real record has no radial lines, and at any
   real opacity this reads as wireframe spokes rather than vinyl. The rotating
   LABEL is what actually sells the spin; this only helps when a track has no
   art. If in doubt, lower it. */
.shimmer {
  position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
  mix-blend-mode: screen; opacity: .02;
  background: repeating-conic-gradient(from 0deg,
    transparent 0deg 1.1deg,
    var(--vinyl-sheen) 1.35deg,
    transparent 1.6deg 3deg);
  -webkit-mask: radial-gradient(circle, transparent 34%, #000 44%, #000 92%, transparent 98%);
  mask: radial-gradient(circle, transparent 34%, #000 44%, #000 92%, transparent 98%);
}

/* Fixed in space, like a room light: the grooves turn under it and the smooth
   land rings glint differently. That contrast is how a real gap reads. */
.sheen {
  position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
  mix-blend-mode: screen; opacity: .85;
  background: conic-gradient(from 188deg, transparent 0deg,
    color-mix(in srgb, var(--vinyl-sheen) 26%, transparent) 13deg,
    color-mix(in srgb, var(--vinyl-sheen) 7%, transparent) 33deg,
    transparent 60deg, transparent 172deg,
    color-mix(in srgb, var(--vinyl-sheen) 17%, transparent) 190deg,
    color-mix(in srgb, var(--vinyl-sheen) 5%, transparent) 210deg,
    transparent 242deg);
}
.iris {
  position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
  mix-blend-mode: screen; opacity: .5;
  background: conic-gradient(from 196deg, transparent 0deg,
    rgba(120,200,255,.15) 9deg, rgba(255,140,220,.12) 19deg,
    rgba(255,220,120,.09) 29deg, transparent 44deg);
  -webkit-mask: radial-gradient(circle, transparent 34%, #000 42%, #000 88%, transparent 95%);
  mask: radial-gradient(circle, transparent 34%, #000 42%, #000 88%, transparent 95%);
}

/* The label is the album art, and it turns with the record. */
.label {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  border-radius: 50%; background-color: var(--bg-tertiary);
  background-size: cover; background-position: center;
  box-shadow: 0 0 0 1px rgba(0,0,0,.35), inset 0 0 0 calc(6px * var(--k)) rgba(0,0,0,.07);
}
.hole {
  position: absolute; left: 50%; top: 50%; width: calc(11px * var(--k)); height: calc(11px * var(--k));
  margin: calc(-5.5px * var(--k)) 0 0 calc(-5.5px * var(--k)); border-radius: 50%;
  background: var(--bg-primary); box-shadow: inset 0 1px 2px rgba(0,0,0,.9);
  pointer-events: none;
}

.gaps { position: absolute; inset: 0; pointer-events: none; }
.gap-ring {
  position: absolute; left: 50%; top: 50%; border-radius: 50%;
  transform: translate(-50%, -50%);
  border: 1px dashed color-mix(in srgb, var(--accent) 72%, transparent);
}

.scrub { position: absolute; inset: 0; border-radius: 50%; cursor: ew-resize; z-index: 15; }

/* .armwrap and .armrise are inset:0, so they cover the WHOLE platter and paint
   above .scrub — without this they swallow every press and neither scrubbing nor
   grabbing the arm works at all.
   Only these two. Do NOT add .armlift: it sits INSIDE .arm, so disabling it
   disables the arm's own graphics (the tube, pivot and headshell all live in it)
   and re-enabling .arm cannot recover them — .arm is a height:0 box with no
   hittable area of its own. */
.armwrap, .armrise { pointer-events: none; }
.arm { pointer-events: auto; }

.armwrap { position: absolute; inset: 0; transform-style: preserve-3d; }

/* Screen-space rise. A black contact shadow is INVISIBLE on black vinyl, so the
   cues that actually read when the arm leaves the record are displacement, size
   and brightness — not shadow. This is the displacement. */
.armrise {
  position: absolute; inset: 0;
  transform-style: preserve-3d;
  transform: translate(0, 0);
  transition: transform .6s cubic-bezier(.16,.84,.28,1);
}
.lifted .armrise {
  transform: translate(calc(-7px * var(--k)), calc(-17px * var(--k)));
  transition: transform .26s cubic-bezier(.34,1.5,.6,1);
}
.mirror-arm .armwrap { transform: scaleX(-1); }

/* Rotation only. This updates every frame as the needle tracks, so it gets a
   short linear transition — just enough to smooth a cue jump. */
.arm {
  position: absolute; height: 0; z-index: 20; transform-origin: 0 50%;
  transform-style: preserve-3d; cursor: grab;
  transform: rotate(var(--deg));
  transition: transform .22s linear;
}
.arm:active { cursor: grabbing; }

/* The LIFT. Separate element so its slow, damped easing can't smear the
   tracking rotation above.
   Timing is deliberately ASYMMETRIC, because that is what a cue lever feels
   like: release is quick and springy, descent is slow and damped. A symmetric
   ease reads as a CSS transition; this reads as a mechanism. */
.armlift {
  position: absolute; left: 0; right: 0; top: 0; height: 0;
  transform-style: preserve-3d;
  transform: translateZ(0);
  filter: drop-shadow(calc(1px * var(--k)) calc(2px * var(--k)) calc(2px * var(--k)) rgba(0,0,0,.55));
  transition: transform .58s cubic-bezier(.16,.84,.28,1), filter .5s ease;
}
.lifted .armlift {
  transform: translateZ(calc(46px * var(--k)));
  filter: drop-shadow(calc(12px * var(--k)) calc(24px * var(--k)) calc(14px * var(--k)) rgba(0,0,0,.65));
  transition: transform .24s cubic-bezier(.34,1.5,.6,1), filter .24s ease;
}
.tube {
  position: absolute; left: calc(8px * var(--k)); right: calc(30px * var(--k)); top: calc(-3px * var(--k)); height: calc(6px * var(--k)); border-radius: calc(3px * var(--k));
  background: linear-gradient(180deg, #e6eaf1, #a9b0bd 40%, #565c69);
  transition: filter .3s ease;
}
/* Raised toward the room light, so it catches more of it. On a black record this
   does more work than any shadow can. */
.lifted .tube, .lifted .head { filter: brightness(1.3) saturate(.9); }
.pivot {
  position: absolute; left: calc(-15px * var(--k)); top: calc(-15px * var(--k)); width: calc(30px * var(--k)); height: calc(30px * var(--k)); border-radius: 50%;
  background: radial-gradient(circle at 34% 28%, #8a919f, #3a3e48 58%, #14171d);
  box-shadow: 0 0 0 1px rgba(0,0,0,.55), inset 0 1px 2px rgba(255,255,255,.4);
}
.pivot::after {
  content: ""; position: absolute; inset: calc(9px * var(--k)); border-radius: 50%;
  background: radial-gradient(circle at 38% 32%, #cfd5e0, #6a7180);
}
.counter {
  position: absolute; left: calc(-46px * var(--k)); top: calc(-9px * var(--k)); width: calc(30px * var(--k)); height: calc(18px * var(--k)); border-radius: calc(4px * var(--k));
  background: linear-gradient(180deg, #565c69, #1c1f26 70%, #10131a);
}
/* Headshell, offset ~22° like a real cartridge mount.
 *
 * LOAD-BEARING: armAngleDeg solves for the ARM'S FAR END sitting on the target
 * groove radius, so the stylus must be drawn at that far end. Previously the
 * cartridge sat mid-headshell and the head rotated about its own left edge,
 * which put the actual contact point ~10% of the radius inside where the maths
 * believed it was — at track 1, position 0 the needle visibly missed the rim.
 *
 * So: the head hangs BACKWARDS from the arm's end (right: 0), and it rotates
 * about 100% 50% — its right edge, i.e. the stylus — so the tilt is cosmetic
 * and cannot move the contact point. Don't reintroduce an offset here without
 * teaching armAngleDeg about it. */
.head {
  position: absolute; right: 0; top: calc(-10px * var(--k)); width: calc(32px * var(--k)); height: calc(20px * var(--k));
  border-radius: calc(3px * var(--k)) calc(6px * var(--k)) calc(6px * var(--k)) calc(3px * var(--k));
  transform: rotate(22deg); transform-origin: 100% 50%;
  transition: transform .3s cubic-bezier(.34,1.4,.5,1);
  background: linear-gradient(180deg, #f2f5f9, #aeb5c1 52%, #656c7a);
  box-shadow: inset 0 1px 1px rgba(255,255,255,.65), 0 0 0 1px rgba(0,0,0,.5);
}
/* Cartridge, centred on the arm's end = the stylus/contact point. */
.head::after {
  content: ""; position: absolute; right: calc(-1px * var(--k)); top: 50%; margin-top: calc(-3px * var(--k));
  width: calc(8px * var(--k)); height: calc(11px * var(--k));
  border-radius: 1px 1px 3px 3px; background: linear-gradient(180deg, #3d434f, #babfc9);
}
/* Contact shadow under the headshell. Deliberately modest: on a near-black
   record a dark shadow has almost no contrast, so it can only ever be a
   supporting cue — it reads at the headshell's own lit edge, not against the
   vinyl. It still separates and softens when lifted, which helps at the boundary
   even where the blob itself is invisible. */
.shadow {
  position: absolute; right: 0; top: calc(-6px * var(--k)); width: calc(26px * var(--k)); height: calc(11px * var(--k));
  border-radius: 50%; background: rgba(0,0,0,.75);
  filter: blur(calc(2px * var(--k))); opacity: .5;
  transform: translate(calc(3px * var(--k)), calc(6px * var(--k))) scale(1);
  transition: transform .6s cubic-bezier(.16,.84,.28,1), filter .5s ease, opacity .5s ease;
}
.lifted .shadow {
  opacity: .55; filter: blur(calc(9px * var(--k)));
  transform: translate(calc(22px * var(--k)), calc(30px * var(--k))) scale(1.6);
  transition: transform .26s cubic-bezier(.34,1.5,.6,1), filter .26s ease, opacity .26s ease;
}
/* Paused: the cue lever raises the arm off the record in real Z. */
/* Never scale() the arm: that lengthens it, walking the contact point outward
   and putting the needle past the rim while paused. Height comes from
   translateZ under the deck's perspective, which is the honest cue anyway — a
   lifted arm really is nearer the eye.
   The headshell rises FURTHER than the pivot, because that is what a tonearm
   does: the pivot is fixed and the far end swings up. */
.lifted .head {
  transform: rotate(22deg) translateZ(calc(34px * var(--k)));
}
.lifted .shadow { opacity: 1; }
`;
