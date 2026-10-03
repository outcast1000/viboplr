// The scenes `scripts/capture-site-media.mjs` captures for the website's
// persona pages (docs/for/*.html), and the pure decisions around them.
//
// Kept apart from the runner for the same reason `appSmoke.mjs` is: the parts
// that decide whether a capture is right (did the page land? which pixels are
// the window?) must be assertable without a running app, a screen or ffmpeg.
// Pinned by `src/__tests__/captureScenes.test.ts`.
//
// A scene is declarative:
//   steps   — control-API calls that put the app in the right state
//   expect  — what GET /v1/ui must report before anything is captured; a
//             mismatch skips the scene instead of saving a picture of the
//             wrong page (the perf probe's `expect` rule, for the same reason)
//   during  — video only: steps fired at `at` ms after recording starts
//   after   — steps that undo the scene, run even when it was skipped
//   needs   — preconditions: "track" (something loaded), "plugin:<id>"
// Step values may reference discovered facts as "$artist" / "$albumTrackIds" /
// "$lyricsTrackId" / "$skin0" (the skin active when the run started).
//
// Two step kinds exist only in the runner: `seekFromEnd: n` (seek to n seconds
// before the current track's end) and `playTemp: id` (insert a library track
// after the current one and jump to it; the runner removes it and returns to
// the original track once the scene is done).

/** Where each scene's media goes on the site, for the end-of-run report. */
/** The mini player's layouts and width presets, smallest first (the app's own
 *  names — `src/utils/miniSizes.ts`; the scene test checks they still parse). */
export const MINI_LAYOUTS = ["compact", "normal", "full"];
export const MINI_WIDTHS = ["small", "medium", "large"];

export const SCENES = [
  // --- Audiophiles ---
  {
    id: "bit-perfect", kind: "video", seconds: 9, needs: ["track"],
    page: "audiophiles", slot: "Bit-perfect mode turning on",
    steps: [{ navigate: { view: "nowplaying" } }, { playback: { play: true } }],
    expect: { view: "nowplaying" },
    during: [
      { at: 1500, action: { action: "bitPerfect", on: true } },
      { at: 3000, action: { action: "bitPerfectConfirm" }, optional: true },
    ],
    after: [{ action: { action: "closeModals" } }, { action: { action: "bitPerfect", on: false }, optional: true }],
  },
  {
    id: "settings-playback", kind: "still",
    page: "audiophiles", slot: "Settings → Playback",
    // `exclusive-audio` is a row near the engine select; the group anchor
    // `playback-engine` is tall enough that centring it scrolls past the
    // engine rows (seen on the first run). Without the native engine the row
    // doesn't exist, the scroll is a no-op and the tab opens at its top —
    // which is the engine select, so either way the shot is right.
    steps: [{ navigate: { settings: "exclusive-audio" } }],
    expect: { view: "settings" },
  },
  {
    // No settle pause, and the seek lands ~1s after recording starts (ffmpeg
    // needs that long to deliver its first frame): with the default settle
    // the track change happened before anything was recorded (first run).
    id: "gapless", kind: "video", seconds: 11, needs: ["track"], settleMs: 0,
    page: "audiophiles", slot: "A gapless transition",
    steps: [{ navigate: { view: "nowplaying" } }, { playback: { play: true } }],
    during: [{ at: 300, seekFromEnd: 5 }],
    expect: { view: "nowplaying" },
  },
  {
    id: "eq-panel", kind: "still", needs: ["track"],
    page: "audiophiles", slot: "The equalizer panel",
    steps: [{ navigate: { view: "nowplaying" } }, { action: { action: "eqPanel", open: true } }],
    expect: { view: "nowplaying", panels: { eqPanel: true } },
    after: [{ action: { action: "eqPanel", open: false }, optional: true }],
  },
  // --- Collectors ---
  {
    id: "bulk-edit", kind: "still",
    page: "collectors", slot: "Bulk edit",
    steps: [{ navigate: { view: "library" } }, { action: { action: "bulkEdit", trackIds: "$albumTrackIds" } }],
    expect: { modals: ["bulk-edit"] },
    after: [{ action: { action: "closeModals" } }],
  },
  // --- Info lovers ---
  {
    id: "lyrics", kind: "video", seconds: 12, needs: ["lyrics"],
    page: "info-lovers", slot: "Synced lyrics",
    steps: [
      { navigate: { view: "nowplaying" } },
      { playTemp: "$lyricsTrackId" },
      { action: { action: "nowPlayingLyrics", open: true } },
      { wait: 4000 }, // lyrics fetch + the first lines scrolling into place
      { seekSecs: 50 },
    ],
    expect: { view: "nowplaying", panels: { lyricsHidden: false } },
  },
  // --- Coders ---
  {
    // No padding around the window: whatever sits behind the mini player is
    // the user's own desktop (the first run caught an editor full of branch
    // names), which has no business on a public page.
    // Pinned to the full layout at the large width: the user's own resting
    // size is whatever they last picked, and the compact one is a 24px strip.
    id: "mini-player", kind: "video", seconds: 8, needs: ["track"],
    page: "coders", slot: "Mini player over an editor",
    steps: [{ playback: { play: true } }, { window: { mini: true, miniSize: "full", miniWidth: "large" } }, { wait: 1500 }],
    after: [{ window: { mini: false } }, { wait: 1500 }],
  },
  {
    // Every layout × width, composed into one transparent image: rows are the
    // layouts (compact, normal, full), columns the widths. The sizes persist,
    // so the run restores the user's own afterwards.
    id: "mini-player-sizes", kind: "grid", needs: ["track"],
    page: "coders", slot: "Mini player sizes",
    rows: MINI_LAYOUTS.map((miniSize) => ({ miniSize })),
    cols: MINI_WIDTHS.map((miniWidth) => ({ miniWidth })),
    steps: [{ playback: { play: true } }],
    after: [{ window: { mini: false } }, { wait: 1500 }],
  },
  // --- Rediscoverers ---
  {
    id: "home", kind: "video", seconds: 10,
    page: "rediscoverers", slot: "The home screen",
    steps: [{ navigate: { view: "home" } }, { action: { action: "scroll", to: "top" } }],
    expect: { view: "home" },
    during: [
      { at: 1500, action: { action: "scroll", to: 700, smooth: true } },
      { at: 4500, action: { action: "scroll", to: 1500, smooth: true } },
      { at: 7500, action: { action: "scroll", to: "top", smooth: true } },
    ],
  },
  {
    id: "mixes", kind: "still",
    page: "rediscoverers", slot: "Playlists → mixes",
    steps: [{ navigate: { view: "playlists" } }],
    expect: { view: "playlists" },
  },
  // --- Downloaders ---
  {
    id: "ytdlp-search", kind: "still", needs: ["plugin:ytdlp"], settleMs: 9000,
    page: "downloaders", slot: "yt-dlp search",
    steps: [{ navigate: { pluginView: { pluginId: "ytdlp", viewId: "ytdlp-search", query: "lofi hip hop radio" } } }],
    expect: { view: "plugin:ytdlp:ytdlp-search" },
  },
  {
    id: "qbittorrent", kind: "still", needs: ["plugin:qbittorrent"], settleMs: 5000,
    page: "downloaders", slot: "qBittorrent in Viboplr",
    steps: [{ navigate: { pluginView: { pluginId: "qbittorrent", viewId: "qbittorrent" } } }],
    expect: { view: "plugin:qbittorrent:qbittorrent" },
  },
  // --- Self-hosters ---
  {
    id: "server-download", kind: "still", needs: ["track"],
    page: "self-hosters", slot: "Download from your server",
    // Over the Now Playing page: on top of whatever view the previous scene
    // left, the dialog sat over a plugin's error banner (default-profile run).
    steps: [{ navigate: { view: "nowplaying" } }, { action: { action: "download" } }, { wait: 1500 }],
    expect: { modals: ["download"] },
    after: [{ action: { action: "closeModals" } }],
  },
  // --- AI ---
  {
    // cropBottom: the rows under the switches show the port, the token's last
    // characters and a discovery path containing the username.
    id: "ai-control", kind: "still", cropBottom: 0.32,
    page: "ai", slot: "Settings → AI control / assistant permissions",
    steps: [{ navigate: { settings: "control-api" } }],
    expect: { view: "settings" },
  },
  // --- Tinkerers ---
  {
    id: "skins", kind: "video", seconds: 11,
    page: "tinkerers", slot: "Switching skins",
    steps: [{ navigate: { artist: "$artist" } }, { action: { action: "heroLook", look: "aurora-drift" } }],
    expect: { view: "artists" },
    during: [
      { at: 1500, skin: "Arctic Light" },
      { at: 4000, skin: "Sunset" },
      { at: 6500, skin: "Forest" },
      { at: 9000, skin: "OLED Black" },
    ],
    // Back to the run's skin straight away, or every later scene is captured
    // in OLED Black (the first run's Spotify still was).
    after: [{ skin: "$skin0" }, { wait: 800 }],
  },
  // --- Spotify ---
  {
    id: "spotify-view", kind: "still", needs: ["plugin:spotify-browse"], settleMs: 6000,
    page: "spotify", slot: "Your Spotify home in Viboplr",
    // Scrolled just past the first shelf's heading: Spotify titles it with a
    // personal greeting line (a song name it picked for this account).
    steps: [
      { navigate: { pluginView: { pluginId: "spotify-browse", viewId: "spotify" } } },
      { wait: 2500 },
      { action: { action: "scroll", to: 70 } },
    ],
    expect: { view: "plugin:spotify-browse:spotify" },
  },
];

/** Placeholders a person has to record: they depend on outside services or
 *  on a pointer gesture the API deliberately does not have. */
export const MANUAL_CAPTURES = [
  { page: "spotify", slot: "A Daily Mix in Viboplr", why: "needs a signed-in Spotify session and a live playlist load" },
  { page: "collectors", slot: "Upgrading a track", why: "needs a real better copy from a download provider" },
  { page: "downloaders", slot: "Soulseek search to library", why: "a real download — pick something you have the right to share; the view's tabs also can't be seeded with a search from the API" },
  { page: "ai", slot: "Claude driving Viboplr", why: "the chat side has to be the real Claude app" },
  { page: "self-hosters", slot: "Public servers", why: "a page of the website, not the app" },
];

/**
 * Compare `GET /v1/ui` against a scene's expectation. Returns every mismatch
 * (empty = good), like `checkDump` — "wrong view" and "panel closed" are
 * independent facts, and both should be visible from one run.
 */
export function checkExpect(state, expect) {
  if (!expect) return [];
  const problems = [];
  if (expect.view !== undefined && state?.view !== expect.view) {
    problems.push(`view is "${state?.view}", wanted "${expect.view}"`);
  }
  for (const [k, v] of Object.entries(expect.panels ?? {})) {
    if (state?.panels?.[k] !== v) problems.push(`panels.${k} is ${state?.panels?.[k]}, wanted ${v}`);
  }
  for (const m of expect.modals ?? []) {
    if (!(state?.modals ?? []).includes(m)) problems.push(`modal "${m}" is not open`);
  }
  return problems;
}

/** Replace "$name" references in step values with discovered facts. A
 *  reference with no value throws: a scene must not run against a guess. */
export function resolveRefs(value, facts) {
  if (typeof value === "string" && value.startsWith("$")) {
    const key = value.slice(1);
    if (facts[key] === undefined || facts[key] === null) throw new Error(`no value for ${value}`);
    return facts[key];
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, facts));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, facts)]));
  }
  return value;
}

/** Which preconditions a scene is missing, given what the app reported. */
export function missingNeeds(scene, { hasTrack, hasLyricsTrack = false, pluginIds }) {
  const missing = [];
  for (const need of scene.needs ?? []) {
    if (need === "track" && !hasTrack) missing.push("nothing loaded to play");
    if (need === "lyrics" && !hasLyricsTrack) missing.push("no library track with cached synced lyrics");
    if (need.startsWith("plugin:") && !pluginIds.includes(need.slice(7))) {
      missing.push(`plugin ${need.slice(7)} not enabled`);
    }
  }
  return missing;
}

/**
 * The screen-pixel rectangle to record: the window's logical frame, padded,
 * scaled to physical pixels, clamped to the screen and rounded to even sizes
 * (H.264 needs even dimensions).
 */
export function cropRect(frame, scale, screen, pad = 0) {
  const x0 = Math.max(0, (frame.x - pad) * scale);
  const y0 = Math.max(0, (frame.y - pad) * scale);
  const x1 = Math.min(screen.width, (frame.x + frame.width + pad) * scale);
  const y1 = Math.min(screen.height, (frame.y + frame.height + pad) * scale);
  const even = (n) => Math.floor(n / 2) * 2;
  return { x: even(x0), y: even(y0), width: even(x1 - x0), height: even(y1 - y0) };
}

/** ffmpeg arguments for the two web encodes of one raw recording. Muted,
 *  at most `maxWidth` wide, mp4 with faststart so it streams. */
export function encodeArgs(raw, base, maxWidth = 1280) {
  const scale = `scale='min(${maxWidth},iw)':-2`;
  return {
    mp4: ["-y", "-i", raw, "-vf", scale, "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "26",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${base}.mp4`],
    webm: ["-y", "-i", raw, "-vf", scale, "-an", "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0",
      "-row-mt", "1", `${base}.webm`],
    poster: ["-y", "-ss", "1", "-i", raw, "-frames:v", "1", "-vf", scale, `${base}-poster.png`],
  };
}

/** Index of the main screen in `ffmpeg -f avfoundation -list_devices true`
 *  output ("[1] Capture screen 0"), or null. */
export function parseScreenDevice(listing) {
  const m = /\[(\d+)\] Capture screen 0/.exec(listing);
  return m ? Number(m[1]) : null;
}

/** `--redact` value → showcase redaction rules: comma-separated entries, each
 *  `text` (hidden as "•••") or `text=replacement`. */
export function parseRedactArg(value) {
  return String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const eq = entry.indexOf("=");
    return eq < 0 ? { text: entry } : { text: entry.slice(0, eq).trim(), replacement: entry.slice(eq + 1).trim() };
  });
}

/** Where each cell of a `grid` scene goes. `cells[row][col]` is a captured
 *  image's `{ width, height }`; a column is as wide as its widest cell and a
 *  row as tall as its tallest, with `gap` between cells and around the edge.
 *  Cells sit top-left in their slot, so each column reads as one width. */
export function gridLayout(cells, gap) {
  const cols = Math.max(0, ...cells.map((r) => r.length));
  const colW = Array.from({ length: cols }, (_, c) => Math.max(0, ...cells.map((r) => r[c]?.width ?? 0)));
  const rowH = cells.map((r) => Math.max(0, ...r.map((cell) => cell.height)));
  const xs = colW.map((_, c) => gap + colW.slice(0, c).reduce((a, w) => a + w + gap, 0));
  const ys = rowH.map((_, r) => gap + rowH.slice(0, r).reduce((a, h) => a + h + gap, 0));
  const even = (n) => Math.ceil(n / 2) * 2;
  return {
    width: even(gap + colW.reduce((a, w) => a + w + gap, 0)),
    height: even(gap + rowH.reduce((a, h) => a + h + gap, 0)),
    at: cells.map((r, ri) => r.map((_, ci) => ({ x: xs[ci], y: ys[ri] }))),
  };
}

/** ffmpeg arguments that paint `pngs` (row-major, matching `layout.at`) onto a
 *  transparent canvas and write one RGBA PNG.
 *
 *  Each cell is a crop of the desktop, so wherever the window itself is
 *  transparent — its rounded corners (Windows 11 rounds every window), its
 *  1px edge — the grab holds whatever sat behind it. `inset` trims that edge
 *  and `radius` gives the cell an anti-aliased rounded alpha mask, so the
 *  composite carries no desktop pixels. `layout` must be built from the
 *  already-inset sizes. */
export function gridComposeArgs(pngs, layout, out, { inset = 0, radius = 0 } = {}) {
  const positions = layout.at.flat();
  if (positions.length !== pngs.length) throw new Error("one png per grid cell");
  const r = radius;
  // Distance past the nearest corner's centre, 0 everywhere but the corners.
  const d = `hypot(max(max(${r}-X,X-(W-1-${r})),0),max(max(${r}-Y,Y-(H-1-${r})),0))`;
  const mask = r > 0 ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip((${r}+0.5-${d})*255,0,255)'` : "";
  const crop = inset > 0 ? `crop=iw-${2 * inset}:ih-${2 * inset}:${inset}:${inset},` : "";
  const chain = [`color=c=black@0.0:s=${layout.width}x${layout.height},format=rgba[c0]`];
  pngs.forEach((_, i) => chain.push(`[${i}:v]${crop}format=rgba${mask}[m${i}]`));
  positions.forEach(({ x, y }, i) => {
    const next = i === positions.length - 1 ? "[out]" : `[c${i + 1}]`;
    chain.push(`[c${i}][m${i}]overlay=${x}:${y}:format=auto${next}`);
  });
  return [
    "-y", "-hide_banner", ...pngs.flatMap((p) => ["-i", p]),
    "-filter_complex", chain.join(";"), "-map", "[out]", "-frames:v", "1", "-pix_fmt", "rgba", out,
  ];
}
