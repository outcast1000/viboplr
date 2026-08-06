var __viboplrPlugin = (function(exports) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	//#region src/geometry.ts
	/**
	* A real 12" LP, in millimetres of disc *radius*.
	*
	* These are the numbers the whole surface derives from. The unplayable outer
	* band is only `disc - maxRecorded` = ~5mm, i.e. 3.3% of the radius — inventing
	* a wider one reads as a black moat that no record actually has.
	*/
	var LP_MM = {
		disc: 151,
		rim: 148.5,
		maxRecorded: 146,
		minRecorded: 60,
		deadWax: 55,
		label: 50,
		gap: 1
	};
	/**
	* Ceiling on the share of the program area the inter-track lands may consume.
	*
	* `MIN_GAP_PX` is a floor per gap, so a long enough queue would demand more
	* total land than the program area has — a 60-track queue wants 118px of gap in
	* a 104px span — and the bands would run straight through the label. Capping
	* the total and dividing it down keeps the pressing inside its geometry. Past
	* this density the deck is unreadable anyway; the contract it must not break is
	* that the last band ends exactly on the run-out.
	*/
	var MAX_GAP_SHARE = .5;
	/** Tonearm mounting, as multiples of the disc radius. */
	var ARM = {
		pivotAngleDeg: -38,
		pivotDistance: 1.12,
		length: 1.28
	};
	/** Build the radii for a deck rendered `size` px across. */
	function buildGeometry(size) {
		const rEdge = Math.max(1, size / 2 - 2);
		const mm = (v) => rEdge * (v / LP_MM.disc);
		return {
			size,
			cx: size / 2,
			cy: size / 2,
			rEdge,
			rRim: mm(LP_MM.rim),
			rLeadIn: mm(LP_MM.maxRecorded),
			rProgIn: mm(LP_MM.minRecorded),
			rDeadWax: mm(LP_MM.deadWax),
			rLabel: mm(LP_MM.label),
			gap: Math.max(2, mm(LP_MM.gap))
		};
	}
	/**
	* Width of the land ring below `bands[i]`, derived from the band table rather
	* than from `geo.gap` — `layoutBands` shrinks the gap when a dense queue can't
	* afford the full one, so the table is the only truthful source.
	*/
	function gapAfter(bands, i) {
		const next = bands[i + 1];
		return next ? Math.max(0, bands[i].inner - next.outer) : 0;
	}
	/**
	* Press a list of track durations into concentric bands, outermost first.
	*
	* Unknown durations are real and common — a metadata-only plugin or streaming
	* track often has none — so when *no* track carries a usable duration the
	* bands are split evenly rather than collapsing to zero width. A partially
	* known list keeps the known proportions and gives the unknown tracks nothing,
	* which is the honest reading: we don't know how long they are.
	*/
	function layoutBands(durations, geo) {
		const n = durations.length;
		if (n === 0) return [];
		const safe = durations.map((d) => typeof d === "number" && Number.isFinite(d) && d > 0 ? d : 0);
		const total = safe.reduce((s, d) => s + d, 0);
		const weights = total > 0 ? safe.map((d) => d / total) : safe.map(() => 1 / n);
		const span = geo.rLeadIn - geo.rProgIn;
		const gap = n > 1 ? Math.min(geo.gap, span * MAX_GAP_SHARE / (n - 1)) : 0;
		const usable = Math.max(0, span - gap * (n - 1));
		const bands = [];
		let r = geo.rLeadIn;
		for (let i = 0; i < n; i++) {
			const width = usable * weights[i];
			bands.push({
				index: i,
				outer: r,
				inner: r - width,
				width,
				durationSecs: safe[i]
			});
			r = r - width - (i < n - 1 ? gap : 0);
		}
		return bands;
	}
	/**
	* Which track, and how far into it, sits at radius `r`.
	*
	* A radius inside a land ring resolves to the *end* of the band above it: the
	* needle is physically between tracks, and reporting the track it just left is
	* less surprising than reporting the one it hasn't reached.
	*/
	function radiusToPosition(bands, r) {
		if (bands.length === 0) return null;
		if (r >= bands[0].outer) return {
			index: 0,
			positionSecs: 0
		};
		for (const b of bands) {
			if (r <= b.outer && r >= b.inner) {
				const frac = b.width > 0 ? (b.outer - r) / b.width : 0;
				return {
					index: b.index,
					positionSecs: frac * b.durationSecs
				};
			}
			if (r < b.inner && b.index < bands.length - 1) {
				if (r > bands[b.index + 1].outer) return {
					index: b.index,
					positionSecs: b.durationSecs
				};
			}
		}
		const last = bands[bands.length - 1];
		return {
			index: last.index,
			positionSecs: last.durationSecs
		};
	}
	/** Radius of the groove `positionSecs` into track `index`. */
	function positionToRadius(bands, index, positionSecs, geo) {
		const b = bands[index];
		if (!b) return geo.rLeadIn;
		if (b.durationSecs <= 0) return b.outer;
		const frac = Math.max(0, Math.min(1, positionSecs / b.durationSecs));
		return b.outer - frac * b.width;
	}
	/** Clamp a radius to the playable program area. */
	function clampToProgram(r, geo) {
		return Math.max(geo.rProgIn, Math.min(geo.rLeadIn, r));
	}
	function buildArmMount(geo) {
		const ang = ARM.pivotAngleDeg * Math.PI / 180;
		const distance = geo.rEdge * ARM.pivotDistance;
		return {
			px: geo.cx + distance * Math.cos(ang),
			py: geo.cy + distance * Math.sin(ang),
			length: geo.rEdge * ARM.length,
			distance
		};
	}
	/**
	* Rotation (deg, CSS-positive = clockwise) that puts the stylus on radius `r`.
	*
	* Law of cosines on the triangle centre-pivot-stylus. Two solutions exist; we
	* take the one that keeps the arm on the same side as its pivot rather than
	* sweeping it across the label.
	*
	* CONTRACT: this solves for a stylus at exactly `mount.length` from the pivot —
	* i.e. at the arm element's FAR END. Whatever renders the arm must draw the
	* contact point there. Drawing the cartridge partway back along the headshell
	* (the natural way to draw one) silently shortens the effective arm and puts the
	* needle inside its true radius — most visibly at track 1, position 0, where it
	* should be sitting on the very rim. See the `.head` rules in style.ts.
	*/
	function armAngleDeg(r, geo, mount) {
		const { distance: D, length: L } = mount;
		const cos = (D * D + L * L - r * r) / (2 * D * L);
		const alpha = Math.acos(Math.max(-1, Math.min(1, cos)));
		return (Math.atan2(geo.cy - mount.py, geo.cx - mount.px) - alpha) * 180 / Math.PI;
	}
	/**
	* Crop windows, in units of the disc radius relative to its centre.
	*
	* A record is radially symmetric: the angular dimension carries no playlist
	* information, only rotation and the glint. One radial slice already holds
	* every band and every gap, so `left-two-thirds` drops the mirror-image right
	* rim and spends the pixels on magnification instead.
	*/
	var COMPOSITIONS = {
		full: {
			x0: -1.05,
			x1: 1.05,
			y0: -1.05,
			y1: 1.05,
			zoom: 1,
			mirrorArm: false
		},
		"left-two-thirds": {
			x0: -1.06,
			x1: .36,
			y0: -.76,
			y1: .76,
			zoom: 1.3,
			mirrorArm: true
		}
	};
	/**
	* Size the viewport *from* the crop region rather than hardcoding pixels, so a
	* composition stays correct when the geometry or deck size changes.
	*/
	function buildCrop(composition, geo) {
		const c = COMPOSITIONS[composition] ?? COMPOSITIONS.full;
		const R = geo.rEdge;
		const sx0 = geo.cx + c.x0 * R;
		const sx1 = geo.cx + c.x1 * R;
		const sy0 = geo.cy + c.y0 * R;
		const sy1 = geo.cy + c.y1 * R;
		return {
			width: Math.round((sx1 - sx0) * c.zoom),
			height: Math.round((sy1 - sy0) * c.zoom),
			left: -sx0 * c.zoom,
			top: -sy0 * c.zoom,
			zoom: c.zoom,
			mirrorArm: c.mirrorArm
		};
	}
	//#endregion
	//#region src/surface.ts
	/** Base groove brightness. */
	var GROOVE_BASE = .125;
	/**
	* How much the cached waveform shows in the groove texture.
	*
	* The studio-black surface keeps this subtle: grooves stay essentially uniform
	* and the track's dynamics only whisper through. Raising it slides toward an
	* overtly data-driven surface; 0 makes the grooves perfectly even.
	*/
	var WAVE_PRESENCE = .075;
	/** Radial distance between painted grooves, px. */
	var GROOVE_PITCH = 1.15;
	/** Radial distance between the coarser lead-in / run-out guide grooves, px. */
	var GUIDE_PITCH = 1.5;
	/**
	* Paint the record surface. Cheap enough to redraw on resize, but it only needs
	* to run when the size or the pressing changes — never on a skin change, and
	* never per animation frame (rotation is a CSS transform on a parent).
	*/
	function paintVinylSurface(canvas, geo, bands, peaks) {
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
		canvas.width = Math.max(1, Math.round(geo.size * dpr));
		canvas.height = Math.max(1, Math.round(geo.size * dpr));
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, geo.size, geo.size);
		const { cx, cy, rEdge, rRim, rLeadIn, rProgIn, rDeadWax, rLabel } = geo;
		const ring = (r, w, colour) => {
			if (r <= .5) return;
			ctx.lineWidth = w;
			ctx.strokeStyle = colour;
			ctx.beginPath();
			ctx.arc(cx, cy, r, 0, Math.PI * 2);
			ctx.stroke();
		};
		const white = (a) => `rgba(255,255,255,${a})`;
		const black = (a) => `rgba(0,0,0,${a})`;
		ring(rEdge - 1, 2, white(.17));
		ring(rRim, 1, black(.9));
		for (let r = rRim - 1.2; r > rLeadIn; r -= GUIDE_PITCH) ring(r, 1, white(.07));
		ring(rLeadIn + .6, 1, black(.95));
		bands.forEach((b, i) => {
			const p = peaks?.[i];
			const n = p ? p.length : 0;
			for (let r = b.outer; r >= b.inner; r -= GROOVE_PITCH) {
				const frac = b.width > 0 ? (b.outer - r) / b.width : 0;
				const amp = n > 0 ? p[Math.min(n - 1, Math.floor(frac * n))] : .5;
				ring(r, .85, white(GROOVE_BASE + amp * WAVE_PRESENCE));
			}
			const gap = gapAfter(bands, i);
			if (gap > 0) {
				const gOut = b.inner;
				const gIn = b.inner - gap;
				ctx.fillStyle = black(1);
				ctx.beginPath();
				ctx.arc(cx, cy, gOut, 0, Math.PI * 2);
				ctx.arc(cx, cy, gIn, 0, Math.PI * 2, true);
				ctx.fill();
				ring(gOut - .5, 1, white(.2));
				ring(gIn + .5, 1, white(.05));
			}
		});
		ring(rProgIn - 1, 1.4, black(.95));
		for (let r = rProgIn - 3; r > rDeadWax; r -= 3.2) ring(r, 1, white(.04));
		ring(rLabel + .5, 1, white(.09));
	}
	//#endregion
	//#region src/style.ts
	var DECK_CSS = `
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
	//#endregion
	//#region src/visualizer.ts
	function createVinylDeckVisualizer(options) {
		let host;
		let root;
		let deck;
		let platter;
		let spin;
		let canvas;
		let label;
		let arm;
		let gapLayer;
		/** The plugin sandbox passes `document: undefined` and a frozen `window`, so
		*  ambient DOM is unavailable by design. Everything comes through the one
		*  handle the contract grants: the shadow root. */
		let doc;
		let geo = buildGeometry(2);
		let mountPoint = buildArmMount(geo);
		let bands = [];
		let size = {
			width: 0,
			height: 0
		};
		let lastRevision = -1;
		let lastArt = null;
		let lastApplied = "";
		let currentIndex = -1;
		const unsubs = [];
		/** Lay out and repaint. Called on a queue or size change — never per frame. */
		function repress(durations) {
			geo = buildGeometry(Math.max(40, Math.min(size.width, size.height)));
			mountPoint = buildArmMount(geo);
			bands = layoutBands(durations, geo);
			const crop = buildCrop(options.composition, geo);
			platter.style.width = `${geo.size}px`;
			platter.style.height = `${geo.size}px`;
			platter.style.transform = crop.zoom === 1 ? "" : `scale(${crop.zoom}) translate(${crop.left / crop.zoom}px, ${crop.top / crop.zoom}px)`;
			canvas.style.width = `${geo.size}px`;
			canvas.style.height = `${geo.size}px`;
			label.style.width = `${geo.rLabel * 2}px`;
			label.style.height = `${geo.rLabel * 2}px`;
			deck.style.setProperty("--k", String(geo.size / 368));
			arm.style.left = `${mountPoint.px}px`;
			arm.style.top = `${mountPoint.py}px`;
			arm.style.width = `${mountPoint.length}px`;
			deck.classList.toggle("mirror-arm", crop.mirrorArm);
			paintVinylSurface(canvas, geo, bands);
			renderGapRings();
		}
		function renderGapRings() {
			gapLayer.textContent = "";
			if (!options.emphasiseGaps) return;
			for (let i = 0; i < bands.length - 1; i++) {
				const d = (bands[i].inner - (bands[i].inner - bands[i + 1].outer) / 2) * 2;
				const ring = doc.createElement("div");
				ring.className = "gap-ring";
				ring.style.width = `${d}px`;
				ring.style.height = `${d}px`;
				gapLayer.append(ring);
			}
		}
		/**
		* Screen point → groove radius.
		*
		* Measure the PLATTER, never the canvas. The canvas lives inside the spinning
		* layer, and getBoundingClientRect() on a rotated element returns the
		* axis-aligned box of the rotated shape — so its width breathes by up to a
		* factor of root-2 and its origin drifts every frame. Measuring it made every
		* computed radius wrong by a varying amount, which silently broke both cue
		* gestures while the drawing still looked perfect.
		*
		* The platter carries the crop's scale, so one factor is still right for every
		* composition.
		*/
		function radiusAt(clientX, clientY) {
			const rect = platter.getBoundingClientRect();
			const unit = rect.width / geo.size || 1;
			const x = (clientX - rect.left) / unit - geo.cx;
			const y = (clientY - rect.top) / unit - geo.cy;
			return Math.hypot(x, y);
		}
		/**
		* Cue by dragging. Uses pointer capture on the element itself rather than
		* window listeners: the sandbox exposes no ambient `window`, and capture is
		* the right primitive regardless — the drag keeps tracking outside the disc
		* and can't be stolen by another element. (Pointer events, not HTML5 DnD,
		* which the repo bans in this webview.)
		*/
		function onDown(e, fromArm = false) {
			if (e.button !== 0 || bands.length === 0) return;
			const r0 = radiusAt(e.clientX, e.clientY);
			if (!fromArm && (r0 < geo.rProgIn || r0 > geo.rLeadIn)) return;
			e.preventDefault();
			const target = e.currentTarget;
			let last = fromArm ? null : radiusToPosition(bands, r0);
			const move = (ev) => {
				last = radiusToPosition(bands, clampToProgram(radiusAt(ev.clientX, ev.clientY), geo));
			};
			const up = () => {
				target.removeEventListener("pointermove", move);
				target.removeEventListener("pointerup", up);
				target.removeEventListener("pointercancel", up);
				if (!last) return;
				if (last.index === currentIndex) host.actions.seek(last.positionSecs);
				else host.actions.playQueueIndex(last.index);
			};
			try {
				target.setPointerCapture(e.pointerId);
			} catch {}
			target.addEventListener("pointermove", move);
			target.addEventListener("pointerup", up);
			target.addEventListener("pointercancel", up);
		}
		return {
			mount(h) {
				host = h;
				root = h.root;
				size = h.size;
				doc = root.ownerDocument;
				const style = doc.createElement("style");
				style.textContent = DECK_CSS;
				root.append(style);
				deck = doc.createElement("div");
				deck.className = "deck lifted";
				deck.innerHTML = "<div class=\"platter\"><div class=\"body\"></div><div class=\"spin\"><canvas></canvas><div class=\"shimmer\"></div><div class=\"label\"></div></div><div class=\"sheen\"></div><div class=\"iris\"></div><div class=\"gaps\"></div><div class=\"hole\"></div><div class=\"scrub\"></div><div class=\"armwrap\"><div class=\"armrise\"><div class=\"arm\"><div class=\"armlift\"><div class=\"counter\"></div><div class=\"pivot\"></div><div class=\"tube\"></div><div class=\"shadow\"></div><div class=\"head\"></div></div></div></div></div></div>";
				root.append(deck);
				platter = deck.querySelector(".platter");
				spin = deck.querySelector(".spin");
				canvas = deck.querySelector("canvas");
				label = deck.querySelector(".label");
				arm = deck.querySelector(".arm");
				gapLayer = deck.querySelector(".gaps");
				deck.querySelector(".scrub").addEventListener("pointerdown", onDown);
				arm.addEventListener("pointerdown", (e) => {
					e.stopPropagation();
					onDown(e, true);
				});
				unsubs.push(h.onResize((s) => {
					size = s;
					lastRevision = -1;
				}));
				unsubs.push(h.onSkinChange(() => {}));
			},
			frame(state) {
				const applied = `${options.composition}|${options.emphasiseGaps}`;
				if (state.queueRevision !== lastRevision || applied !== lastApplied) {
					lastRevision = state.queueRevision;
					lastApplied = applied;
					repress(state.queue.map((t) => t.durationSecs));
				}
				deck.style.setProperty("--tilt", `${options.tilt}deg`);
				if (bands.length === 0) return;
				currentIndex = state.currentIndex;
				const art = state.queue[state.currentIndex]?.artUrl ?? null;
				if (art !== lastArt) {
					lastArt = art;
					label.style.backgroundImage = art ? `url("${art}")` : "";
				}
				const idx = Math.max(0, Math.min(bands.length - 1, state.currentIndex));
				const r = positionToRadius(bands, idx, state.positionSecs, geo);
				arm.style.setProperty("--deg", `${armAngleDeg(r, geo, mountPoint).toFixed(2)}deg`);
				deck.classList.toggle("lifted", !state.playing);
				if (!host.reducedMotion) spin.style.transform = `rotate(${state.timeMs / 1800 * 360 % 360}deg)`;
			},
			destroy() {
				for (const u of unsubs) try {
					u();
				} catch {}
				unsubs.length = 0;
			}
		};
	}
	//#endregion
	//#region src/index.ts
	var STORE_KEY = "settings";
	var DEFAULTS = {
		composition: "full",
		tilt: 0,
		emphasiseGaps: false
	};
	var TILTS = [
		0,
		16,
		28,
		42
	];
	/**
	* One live options object, shared by reference with every mounted visualizer.
	*
	* The host re-mounts only when the slot's selection changes, so a settings
	* change would otherwise never reach a running deck. Mutating this in place lets
	* it pick the change up on its next frame.
	*/
	var options = { ...DEFAULTS };
	function activate(api) {
		function save() {
			api.storage.set(STORE_KEY, options).catch((e) => {
				api.log("error", `Failed to save settings: ${e}`, "vinyl-deck");
			});
		}
		function renderSettings() {
			api.ui.setViewData("vinyl-deck-settings", {
				type: "section",
				title: "Vinyl Deck",
				children: [
					{
						type: "text",
						content: "Right-click the Now Playing artwork to put the deck in that slot.",
						className: "settings-hint"
					},
					{
						type: "select",
						label: "Composition",
						description: "A record is radially symmetric, so the right-hand rim duplicates the left. Cropping it spends those pixels on magnification instead.",
						action: "set-composition",
						value: options.composition,
						options: [{
							value: "full",
							label: "Full disc"
						}, {
							value: "left-two-thirds",
							label: "Left two-thirds (magnified)"
						}]
					},
					{
						type: "select",
						label: "Platter tilt",
						description: "Cueing is exact when flat; while tilted the radius is read from the on-screen projection.",
						action: "set-tilt",
						value: String(options.tilt),
						options: TILTS.map((t) => ({
							value: String(t),
							label: t === 0 ? "Flat" : `${t}°`
						}))
					},
					{
						type: "toggle",
						label: "Outline the track gaps",
						description: "The land between tracks is smooth black, read by its glint. Outline it when you want to read the structure deliberately.",
						action: "set-gaps",
						checked: options.emphasiseGaps
					}
				]
			});
		}
		api.ui.onAction("set-composition", (v) => {
			const raw = typeof v === "string" ? v : v?.value;
			if (raw === "full" || raw === "left-two-thirds") {
				options.composition = raw;
				save();
				renderSettings();
			}
		});
		api.ui.onAction("set-tilt", (v) => {
			const raw = typeof v === "string" ? v : v?.value;
			const n = Number.parseInt(String(raw), 10);
			options.tilt = Number.isNaN(n) ? 0 : n;
			save();
			renderSettings();
		});
		api.ui.onAction("set-gaps", (v) => {
			options.emphasiseGaps = typeof v === "boolean" ? v : !options.emphasiseGaps;
			save();
			renderSettings();
		});
		api.visualizers.onMount("deck", () => createVinylDeckVisualizer(options));
		api.storage.get(STORE_KEY).then((saved) => {
			if (saved && typeof saved === "object") Object.assign(options, saved);
			renderSettings();
		}).catch((e) => {
			api.log("error", `Failed to load settings: ${e}`, "vinyl-deck");
			renderSettings();
		});
	}
	function deactivate() {}
	//#endregion
	exports.activate = activate;
	exports.deactivate = deactivate;
	return exports;
})({});
return __viboplrPlugin;
