// YouTube Shorts made from the running app — the pure half of
// `scripts/make-short.mjs` (`npm run short`). Scenarios per persona are in
// docs/brainstorms/2026-10-24-youtube-shorts-scenarios-requirements.md.
//
// How a short is made: the whole window is recorded at full resolution while
// timed **beats** drive the app (scene steps from captureRunner.mjs —
// navigate, ui actions, and the generic click / type / key input with its
// visible cursor). Each beat names a **focus** — an element found through
// `POST /v1/ui/query`, a fixed rect, or the whole window — and the runner
// records where it was on screen when the beat ran. Afterwards a virtual
// camera turns those keyframes into a moving 9:16 crop (ffmpeg `zoompan`
// over a canvas that letterboxes the window on a blurred copy of itself),
// burns in captions rendered as PNGs, and appends an end card.
//
// Everything here is pure so the framing and the filter graph are asserted
// without a screen or ffmpeg: `src/__tests__/shorts.test.ts`.

/** Output frame, the Shorts format. */
export const SHORT_W = 1080;
export const SHORT_H = 1920;
export const SHORT_FPS = 30;
/** Seconds a camera move takes. */
export const DEFAULT_MOVE_SECS = 0.7;
/** The camera never crops narrower than this many source pixels: below it
 *  1080 output columns would be upscaled past what reads as sharp. */
export const MIN_CROP_SOURCE_W = 920;
/** Where a caption box starts (output px from the top): clear of the Shorts
 *  player's own top chrome. */
export const CAPTION_TOP = 250;
/** Seconds the end card holds. */
export const END_CARD_SECS = 2.5;

/**
 * The scenarios. A beat runs at `at` ms after recording starts:
 *   steps   — scene steps (captureRunner `runStep`), run in order
 *   settle  — ms to wait after them before measuring the focus (default 350)
 *   focus   — { target, pad? } (ui.query target, CSS px padding),
 *             { rect: [x, y, w, h], pad? } (viewport CSS px) or { full: true };
 *             absent = the camera holds
 *   caption — text shown from this beat until the next caption (or `until` ms)
 * `captionTop` (output px, default CAPTION_TOP) moves every caption of a short
 * — a portrait window leaves only a thin band above it, so a caption up there
 * covers the window's own headline.
 * `setup` runs before recording, `after` once it is done (also on failure).
 * Step values may use the runner's facts ("$compilationTrackIds").
 */
export const SHORTS = [
  {
    id: "collectors-bulk-edit",
    persona: "collectors",
    title: "Fix a hundred tracks at once",
    needs: ["demo", "compilation"],
    seconds: 19,
    // The window size every rect below is authored for.
    window: { width: 1440, height: 900 },
    setup: [
      { action: { action: "closeModals" } },
      { action: { action: "queuePanel", open: false } },
      { navigate: { view: "library" } },
      { wait: 800 },
      { type: { target: { role: "field", name: "Search your library..." }, text: "", replace: true, moveMs: 0 } },
      { wait: 400 },
      // Optional: the tabs render once the view has searched, which it does
      // for the empty query too — a missed click only costs the first frame.
      { click: { role: "tab", name: "Albums" }, moveMs: 0, optional: true },
      { wait: 600 },
    ],
    beats: [
      {
        at: 0,
        focus: { rect: [220, 52, 640, 760] },
        caption: "One compilation.\nTwelve albums?",
        steps: [
          { wait: 600 },
          { type: { target: { role: "field", name: "Search your library..." }, text: "Late Night Drive", charMs: 45, moveMs: 500 } },
        ],
      },
      {
        at: 4200,
        focus: { rect: [220, 52, 640, 760] },
        caption: "Select them all",
        steps: [
          { click: { role: "tab", name: "Tracks" }, moveMs: 450 },
          { wait: 500 },
          { key: "Mod+A" },
        ],
      },
      {
        at: 7000,
        focus: { target: { role: "field", name: "Album artist" }, pad: 200 },
        caption: "Edit once",
        settle: 600,
        steps: [{ action: { action: "bulkEdit", trackIds: "$compilationTrackIds" } }],
      },
      {
        at: 8600,
        focus: { target: { role: "field", name: "Album artist" }, pad: 120 },
        steps: [
          { type: { target: { role: "field", name: "Album artist" }, text: "Various Artists", charMs: 60, moveMs: 500 } },
        ],
      },
      {
        at: 11000,
        focus: { target: { role: "button", name: "Save Changes" }, pad: 260 },
        caption: "Written to the files,\nnot just the app",
        steps: [{ click: { role: "button", name: "Save Changes" }, moveMs: 550 }],
      },
      {
        at: 13800,
        focus: { rect: [220, 52, 640, 760] },
        caption: "One album.\nEvery performer kept.",
        settle: 800,
        steps: [{ click: { role: "tab", name: "Albums" }, moveMs: 450 }],
      },
      {
        at: 16200,
        focus: { rect: [220, 52, 760, 760] },
        steps: [{ navigate: { album: "Late Night Drive", artistName: "Various Artists" } }],
      },
    ],
    after: [
      { action: { action: "closeModals" }, optional: true },
      { type: { target: { role: "field", name: "Search your library..." }, text: "", replace: true, moveMs: 0 }, optional: true },
    ],
  },
  {
    // The pipeline's PoC: existing verbs only (no on-camera input), so a take
    // proves the camera, captions and end card without Click and type.
    // A taller-than-wide window: at 1440×900 the whole window is a strip a
    // third of the frame high (first take), at 760×1000 it fills three
    // quarters, and the artist page still lays out (queue panel closed).
    // 960 high, not 1000: at y=60 a taller window runs under the Dock, which
    // the grab then records.
    // Skins alternate light and dark — dark-to-dark flips barely read on a
    // phone. The hero looks get a closer camera on the photo + title.
    id: "tinkerers-skins",
    persona: "tinkerers",
    title: "Make it look like yours",
    needs: ["demo"],
    seconds: 17,
    window: { width: 760, height: 960 },
    // Low, over the track list: the band above the window is ~280px, and a
    // caption at the default top covers the artist's name.
    captionTop: 1180,
    setup: [
      { action: { action: "closeModals" } },
      { action: { action: "queuePanel", open: false } },
      { skin: "Vibo" },
      { navigate: { artist: "$artist" } },
      { action: { action: "heroLook", look: "aurora-drift" } },
      { action: { action: "scroll", to: "top" } },
      { wait: 1500 },
    ],
    beats: [
      { at: 0, focus: { full: true }, caption: "Make it look\nlike yours" },
      { at: 2400, steps: [{ skin: "Arctic Light" }], caption: "Any color" },
      { at: 4200, steps: [{ skin: "Ocean Blue" }] }, // not Sunset: the same magenta as Vibo on a phone
      { at: 6000, steps: [{ skin: "Silver" }] },
      { at: 7800, steps: [{ skin: "Forest" }] },
      {
        at: 9600,
        focus: { rect: [52, 40, 460, 320], pad: 40 },
        caption: "Any mood",
        steps: [{ skin: "Vibo" }, { action: { action: "heroLook", look: "silent-film" } }],
      },
      // The most different looks: late-night and prism-bloom read the same at
      // phone size (first take).
      { at: 11400, steps: [{ action: { action: "heroLook", look: "broadcast" } }] },
      { at: 13200, steps: [{ action: { action: "heroLook", look: "light-leak" } }] },
      {
        at: 15000,
        focus: { full: true },
        caption: "Or make your own skin",
        steps: [{ skin: "Arctic Light" }, { action: { action: "heroLook", look: "aurora-drift" } }],
      },
    ],
  },
  {
    // "Pure, or shaped": bit-perfect on (its confirm dialog says what it does,
    // which is the readable half — the bar's gem is a 14px colour accent),
    // off again, then the EQ curve moving through presets. In that order
    // because bit-perfect suspends the EQ.
    // The confirm prints the output device's name: record on built-in
    // speakers, not a DAC or headphones named after a person.
    // The gem is on the bar only while the mode is on (unpinned), so turning
    // it ON is the `bitPerfect` action and turning it off is the click.
    id: "audiophiles-pure-or-shaped",
    persona: "audiophiles",
    title: "Pure, or shaped",
    needs: ["demo"],
    seconds: 22,
    // Not tinkerers' 760: the bar drops its audio pill (EQ, the gem, volume)
    // at 920px and below (NowPlayingBar.css), and both beats live in it.
    window: { width: 940, height: 960 },
    setup: [
      { action: { action: "closeModals" } },
      { action: { action: "bitPerfect", on: false }, optional: true },
      { action: { action: "eqPanel", open: false }, optional: true },
      { action: { action: "queuePanel", open: false } },
      // Not Vibo: its success token is the accent pink, so "verified" would
      // look like "checking". Here success is green.
      { skin: "Default Dark Blue" },
      { navigate: { view: "nowplaying" } },
      { playback: { play: true } },
      { wait: 1500 },
    ],
    beats: [
      { at: 0, focus: { full: true }, caption: "Hear the file.\nNot the mixer." },
      {
        at: 2600,
        focus: { target: { role: "button", name: "Enable" }, pad: 280 },
        settle: 700,
        caption: "Bit-perfect:\nexactly as it's stored",
        steps: [{ action: { action: "bitPerfect", on: true } }],
      },
      // No dialog when the profile ticked "Don't ask again": the click
      // misses and the mode is already on.
      { at: 6000, steps: [{ click: { role: "button", name: "Enable" }, moveMs: 600, optional: true }] },
      {
        // The camera gets there before the verdict: the gem turns from the
        // accent ("checking") to the success colour with a dot ~3s after
        // Enable (first take), and that change is the beat.
        at: 7200,
        focus: { target: { role: "button", name: "Bit-perfect" }, pad: 260 },
        settle: 300,
        caption: "Exclusive output.\nVerified per track.",
      },
      { at: 11200, steps: [{ check: "bitPerfect" }] },
      {
        at: 12400,
        focus: { target: { role: "button", name: "Vocal" }, pad: 280 },
        settle: 600,
        caption: "Or shape it",
        steps: [
          { click: { role: "button", name: "Bit-perfect" }, moveMs: 500 },
          { wait: 400 },
          { action: { action: "eqPanel", open: true } },
        ],
      },
      { at: 14400, steps: [{ click: { role: "button", name: "Bass Boost" }, moveMs: 450 }] },
      { at: 15900, steps: [{ click: { role: "button", name: "Vocal" }, moveMs: 400 }], caption: "Ten bands.\nYour presets." },
      { at: 17400, steps: [{ click: { role: "button", name: "Electronic" }, moveMs: 400 }] },
      { at: 19200, focus: { full: true }, caption: "Pure, or shaped.\nYour call." },
    ],
    // The preset clicks switched the EQ on: put it back to Flat and Off, or
    // the next take and the site's `eq-panel` still inherit it.
    after: [
      { action: { action: "closeModals" } },
      { action: { action: "bitPerfect", on: false } },
      { action: { action: "eqPanel", open: true } },
      { click: { role: "button", name: "Flat" }, moveMs: 0 },
      { click: { role: "checkbox", name: "On" }, moveMs: 0 },
      { action: { action: "eqPanel", open: false } },
    ],
  },
];

/** Whether a scenario clicks, types or presses keys on camera — those need
 *  the profile's **Click and type** switch; the rest run without it. */
export function usesInput(scene) {
  const steps = [...(scene.setup ?? []), ...(scene.after ?? []), ...scene.beats.flatMap((b) => b.steps ?? [])];
  return steps.some((s) => s.click || s.type || s.key);
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** The canvas the camera moves over: the recorded window letterboxed into a
 *  9:16 frame of the same width (even dimensions, for yuv420p). */
export function canvasFor(videoW, videoH) {
  const height = Math.max(videoH, Math.ceil((videoW * 16) / 9 / 2) * 2);
  return { width: videoW, height, top: Math.round((height - videoH) / 2), videoH };
}

/** A viewport rect (CSS px) in recorded-video pixels. */
export function toVideoRect([x, y, w, h], scale) {
  return [x * scale, y * scale, w * scale, h * scale];
}

/**
 * The 9:16 camera region (canvas px) that shows `rect` (video px) with `pad`
 * around it: as tight as the sharpness floor allows, centred on the rect,
 * never off the canvas, and — when the region is shorter than the video —
 * never into the letterbox bands.
 */
export function frameRegion(rect, canvas, { pad = 0, minWidth = MIN_CROP_SOURCE_W } = {}) {
  if (!rect) return { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const [rx, ry, rw, rh] = rect;
  let w = Math.max(rw + 2 * pad, ((rh + 2 * pad) * 9) / 16);
  w = clamp(w, Math.min(minWidth, canvas.width), canvas.width);
  const h = (w * 16) / 9;
  const x = clamp(rx + rw / 2 - w / 2, 0, canvas.width - w);
  const top = canvas.top;
  const bottom = canvas.top + canvas.videoH;
  const lo = Math.min(top, bottom - h);
  const hi = Math.max(top, bottom - h);
  let y = clamp(ry + top + rh / 2 - h / 2, lo, hi);
  y = clamp(y, 0, canvas.height - h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

const num = (v) => Number(v.toFixed(3)).toString();

/**
 * An ffmpeg expression for one camera coordinate over time: hold each
 * keyframe's value, and ease (smoothstep) from the previous one over
 * `moveSecs` starting at the keyframe — shortened when the next keyframe
 * comes sooner. `t` is the expression for the time in seconds.
 */
export function piecewiseExpr(keys, field, { moveSecs = DEFAULT_MOVE_SECS, t = "(on/30)" } = {}) {
  if (keys.length === 0) throw new Error("the camera needs at least one keyframe");
  return nestKeys(keys, field, moveSecs, t);
}

function nestKeys(keys, field, moveSecs, t) {
  const segs = [];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1].region[field];
    const b = keys[i].region[field];
    const start = keys[i].t;
    const next = keys[i + 1]?.t ?? Infinity;
    const d = Math.max(0.05, Math.min(moveSecs, next - start));
    const u = `clip((${t}-${num(start)})/${num(d)},0,1)`;
    segs.push({ start, end: start + d, from: a, eased: a === b ? num(b) : `${num(a)}+${num(b - a)}*${u}*${u}*(3-2*${u})` });
  }
  // value(t) = v0 before the first move; during move i its ease; after it
  // the move's target until the next one starts.
  let expr = num(keys[keys.length - 1].region[field]);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    expr = `if(lt(${t},${num(s.end)}),${s.eased},${expr})`;
    expr = `if(lt(${t},${num(s.start)}),${num(s.from)},${expr})`;
  }
  return expr;
}

/** zoompan arguments for the camera: zoom from the region width, x/y as the
 *  region's corner. The expressions are single-quoted, which protects their
 *  commas from the filtergraph parser (escaping them as well would hand the
 *  evaluator a literal backslash). */
export function cameraFilter(keys, canvas, { fps = SHORT_FPS, moveSecs = DEFAULT_MOVE_SECS } = {}) {
  const t = `(on/${fps})`;
  const w = piecewiseExpr(keys, "w", { moveSecs, t });
  const x = piecewiseExpr(keys, "x", { moveSecs, t });
  const y = piecewiseExpr(keys, "y", { moveSecs, t });
  return `zoompan=z='${canvas.width}/(${w})':x='${x}':y='${y}':d=1:s=${SHORT_W}x${SHORT_H}:fps=${fps}`;
}

/** When each caption shows: from its beat's real start to the next caption
 *  (or its own `until`), never past the recording. Seconds. */
export function captionWindows(beats, durationSecs) {
  const withText = beats.filter((b) => b.caption);
  return withText.map((b, i) => {
    const start = b.startedAt;
    const next = withText[i + 1]?.startedAt ?? durationSecs;
    const end = b.until !== undefined ? Math.min(next, start + b.until / 1000) : next;
    return { text: b.caption, start: Number(start.toFixed(2)), end: Number(Math.max(start + 0.5, end - 0.05).toFixed(2)) };
  });
}

/**
 * The whole ffmpeg command for the finished short: the recording (input 0),
 * one looped PNG per caption, the end card, and optionally a music bed.
 * Silent unless `music` is given — the platform's own audio tools are the
 * other way to add sound (see the scenarios doc on audio rights).
 */
export function composeArgs({ raw, canvas, keys, captions, captionPngs, endCard, out, durationSecs, music = null, fps = SHORT_FPS }) {
  const inputs = ["-i", raw];
  for (let i = 0; i < captions.length; i++) {
    inputs.push("-loop", "1", "-framerate", String(fps), "-t", String(captions[i].end), "-i", captionPngs[i]);
  }
  const endIdx = captions.length + 1;
  inputs.push("-loop", "1", "-framerate", String(fps), "-t", String(END_CARD_SECS), "-i", endCard);
  const total = durationSecs + END_CARD_SECS;
  const musicIdx = music ? endIdx + 1 : null;
  if (music) inputs.push("-i", music);

  const g = [];
  // The backdrop: the recording itself, blurred and darkened, filling the
  // canvas — cheap blur at an eighth of the size, scaled back up.
  g.push(`[0:v]fps=${fps},setsar=1,split[win][bgsrc]`);
  g.push(`[bgsrc]scale=${Math.round(canvas.width / 8)}:${Math.round(canvas.height / 8)}:force_original_aspect_ratio=increase,`
    + `crop=${Math.round(canvas.width / 8)}:${Math.round(canvas.height / 8)},boxblur=12:2,eq=brightness=-0.18,`
    + `scale=${canvas.width}:${canvas.height}[bg]`);
  g.push(`[bg][win]overlay=0:${canvas.top}[canvas]`);
  g.push(`[canvas]${cameraFilter(keys, canvas, { fps })},setsar=1[cam0]`);
  let last = "cam0";
  captions.forEach((c, i) => {
    const fadeOut = Math.max(c.start, c.end - 0.25);
    g.push(`[${i + 1}:v]format=rgba,fade=t=in:st=${c.start}:d=0.25:alpha=1,fade=t=out:st=${fadeOut}:d=0.25:alpha=1[cap${i}]`);
    g.push(`[${last}][cap${i}]overlay=0:0:enable='between(t,${c.start},${c.end})'[cam${i + 1}]`);
    last = `cam${i + 1}`;
  });
  g.push(`[${last}]trim=duration=${durationSecs},setpts=PTS-STARTPTS,format=yuv420p[main]`);
  g.push(`[${endIdx}:v]scale=${SHORT_W}:${SHORT_H},setsar=1,format=yuv420p,fade=t=in:st=0:d=0.3[end]`);
  g.push(`[main][end]concat=n=2:v=1:a=0[v]`);
  const maps = ["-map", "[v]"];
  if (musicIdx !== null) {
    g.push(`[${musicIdx}:a]atrim=duration=${total},asetpts=PTS-STARTPTS,afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, total - 1.5)}:d=1.5[a]`);
    maps.push("-map", "[a]", "-c:a", "aac", "-b:a", "192k");
  }
  return [
    "-y", "-hide_banner", ...inputs,
    "-filter_complex", g.join(";"),
    ...maps,
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-movflags", "+faststart", "-t", String(total), out,
  ];
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One caption as a full-frame transparent page, rendered to PNG by the
 *  runner (a headless browser — this ffmpeg build has no drawtext, and HTML
 *  gives the site's type and gradient for free). Top safe area: the Shorts
 *  player covers the bottom quarter and the right edge with its own UI. */
export function captionHtml(text, { top = CAPTION_TOP } = {}) {
  const lines = text.split("\n").map((l) => `<span>${escapeHtml(l)}</span>`).join("<br>");
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;800&display=block" rel="stylesheet">
<style>
html,body{margin:0;width:${SHORT_W}px;height:${SHORT_H}px;background:transparent;overflow:hidden}
.cap{position:absolute;left:60px;right:120px;top:${top}px;display:flex;justify-content:center}
.box{font-family:Outfit,"Avenir Next","Helvetica Neue",sans-serif;font-weight:800;font-size:76px;line-height:1.12;
color:#fff;text-align:center;padding:26px 40px;border-radius:28px;background:rgba(10,10,18,.72);
box-shadow:0 10px 40px rgba(0,0,0,.35)}
</style></head><body><div class="cap"><div class="box">${lines}</div></div></body></html>`;
}

/** The closing card: the wordmark (the site's pink→magenta gradient), the
 *  positioning line and the address. `iconSvg` is docs/assets/icon.svg. */
export function endCardHtml(iconSvg, tagline = "The player for music you own") {
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&display=block" rel="stylesheet">
<style>
html,body{margin:0;width:${SHORT_W}px;height:${SHORT_H}px;overflow:hidden;background:radial-gradient(120% 80% at 50% 35%,#2a1030 0%,#0c0a12 60%)}
.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:36px;
font-family:Outfit,"Avenir Next","Helvetica Neue",sans-serif;color:#fff}
.icon{width:260px;height:260px}.icon svg{width:100%;height:100%}
.word{font-size:180px;font-weight:800;letter-spacing:-4px;background:linear-gradient(90deg,#ff5fa2,#c03ce0);
-webkit-background-clip:text;background-clip:text;color:transparent}
.tag{font-size:58px;font-weight:600;opacity:.92;text-align:center;padding:0 80px}
.url{font-size:52px;font-weight:400;opacity:.7}
</style></head><body><div class="wrap"><div class="icon">${iconSvg}</div><div class="word">Vibo</div>
<div class="tag">${escapeHtml(tagline)}</div><div class="url">viboplr.com</div></div></body></html>`;
}
