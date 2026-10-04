// Procedural cover art and artist portraits for the demo library
// (`scripts/make-demo-library.mjs`). Dependency-free on purpose: a PNG is a
// zlib stream with a few chunk headers, and pulling in an image library to
// draw circles and stripes would be the kind of convenience dependency this
// project avoids.
//
// Every picture is a pure function of its seed, so re-running the generator
// reproduces the same library pixel for pixel — the site's captures can be
// re-shot without the covers changing under them.
//
// Nothing here draws text or faces: the art has to read as "album cover" in a
// thumbnail without resembling any real release or person.

import { deflateSync } from "node:zlib";

/** mulberry32: small, fast, good enough for art and play counts. */
export function rng(seed) {
  let a = typeof seed === "number" ? seed >>> 0 : hashString(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Curated palettes: background first, then accents. Hand-picked so any
// combination a painter draws from one palette still looks deliberate.
export const PALETTES = [
  ["#1d1a2f", "#f2545b", "#f3c677", "#7de2d1", "#f5f0e8"],
  ["#0f2a3d", "#e8a87c", "#d85d5d", "#41b3a3", "#f6efe0"],
  ["#f4ecd8", "#e4572e", "#29335c", "#f3a712", "#669bbc"],
  ["#2b2d42", "#8d99ae", "#edf2f4", "#ef233c", "#d90429"],
  ["#13293d", "#006494", "#247ba0", "#1b98e0", "#e8f1f2"],
  ["#fcf6bd", "#ff99c8", "#a9def9", "#d0f4de", "#e4c1f9"],
  ["#22223b", "#4a4e69", "#9a8c98", "#c9ada7", "#f2e9e4"],
  ["#264653", "#2a9d8f", "#e9c46a", "#f4a261", "#e76f51"],
  ["#0b0c10", "#45a29e", "#66fcf1", "#c5c6c7", "#1f2833"],
  ["#3d405b", "#e07a5f", "#f4f1de", "#81b29a", "#f2cc8f"],
  ["#10002b", "#5a189a", "#9d4edd", "#e0aaff", "#ff9e00"],
  ["#f8f4e3", "#2d3142", "#bf4342", "#e7d7c1", "#8c1c13"],
  ["#081c15", "#1b4332", "#52b788", "#b7e4c7", "#d8f3dc"],
  ["#2e1f27", "#854d27", "#dd7230", "#f4c95d", "#e7e393"],
  ["#14213d", "#fca311", "#e5e5e5", "#ffffff", "#000000"],
  ["#1a1423", "#3d314a", "#684756", "#96705b", "#ab8476"],
];

function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Painters: (u, v, ctx) → [r, g, b] for u, v in [0, 1). `ctx` carries the
 * palette (as RGB triples), a `r()` random source already consumed for the
 * layout, and `px` — one pixel in uv units, for anti-aliased edges.
 */
const PAINTERS = {
  // A low sun over banded water and a ridge line.
  horizon(ctx) {
    const [bg, a, b, c, d] = ctx.pal;
    const sunY = 0.32 + ctx.r() * 0.12, sunR = 0.16 + ctx.r() * 0.08, sunX = 0.35 + ctx.r() * 0.3;
    const horizon = 0.58 + ctx.r() * 0.08;
    const ridge = [ctx.r() * 6, ctx.r() * 6, 2 + ctx.r() * 3];
    return (u, v) => {
      if (v < horizon) {
        let col = mix(bg, c, smooth(0, horizon, v) * 0.55);
        const dist = Math.hypot(u - sunX, v - sunY);
        col = mix(col, a, 1 - smooth(sunR - ctx.px, sunR + ctx.px, dist));
        const ridgeY = horizon - 0.06 - 0.05 * Math.sin(u * ridge[2] * 3 + ridge[0]) - 0.03 * Math.sin(u * 11 + ridge[1]);
        return mix(col, b, smooth(ridgeY - ctx.px, ridgeY + ctx.px, v));
      }
      const band = Math.floor((v - horizon) * 40 * (1 + (v - horizon) * 3));
      const shimmer = Math.abs(u - sunX) < sunR * (1 - (v - horizon) * 1.2) && band % 2 === 0;
      return shimmer ? mix(a, d, 0.3) : mix(b, bg, 0.35 + (band % 2) * 0.15);
    };
  },
  // A 3×3 grid of tiles, each holding a quarter or half circle.
  bauhaus(ctx) {
    const tiles = Array.from({ length: 9 }, () => ({
      bg: 1 + Math.floor(ctx.r() * 4), fg: 1 + Math.floor(ctx.r() * 4),
      cx: Math.round(ctx.r()), cy: Math.round(ctx.r()), kind: Math.floor(ctx.r() * 3),
    }));
    return (u, v) => {
      const gx = Math.min(2, Math.floor(u * 3)), gy = Math.min(2, Math.floor(v * 3));
      const lu = u * 3 - gx, lv = v * 3 - gy;
      const t = tiles[gy * 3 + gx];
      const bgc = ctx.pal[t.bg], fgc = ctx.pal[t.fg === t.bg ? 0 : t.fg];
      if (t.kind === 2) {
        const d = Math.hypot(lu - 0.5, lv - 0.5);
        return mix(bgc, fgc, 1 - smooth(0.36 - ctx.px * 3, 0.36 + ctx.px * 3, d));
      }
      const d = Math.hypot(lu - t.cx, lv - t.cy);
      const r = t.kind === 0 ? 1 : 0.6;
      return mix(bgc, fgc, 1 - smooth(r - ctx.px * 3, r + ctx.px * 3, d));
    };
  },
  // Concentric rings around an off-centre point.
  rings(ctx) {
    const cx = 0.2 + ctx.r() * 0.6, cy = 0.2 + ctx.r() * 0.6;
    const freq = 9 + ctx.r() * 10;
    const order = [1, 2, 3, 4].sort(() => ctx.r() - 0.5);
    return (u, v) => {
      const d = Math.hypot(u - cx, v - cy) * freq;
      const i = Math.floor(d);
      // No inner edge on the centre disc, or it renders as a stray dot.
      const edge = i === 0 ? 1 : smooth(0, ctx.px * freq * 2, d - i);
      const inner = ctx.pal[order[(i + 3) % 4]], outer = ctx.pal[order[i % 4]];
      return i > 7 ? mix(ctx.pal[0], outer, 0.15) : mix(inner, outer, edge);
    };
  },
  // Stacked sine bands, like a contour map.
  waves(ctx) {
    const phase = ctx.r() * 10, amp = 0.02 + ctx.r() * 0.05, freq = 3 + ctx.r() * 6, n = 7 + Math.floor(ctx.r() * 6);
    return (u, v) => {
      const w = v + amp * Math.sin(u * freq * Math.PI + phase + v * 4) + amp * 0.5 * Math.sin(u * 17 + phase);
      const band = Math.floor(w * n);
      return ctx.pal[((band % 5) + 5) % 5];
    };
  },
  // A metaball field posterised into the palette: organic, soft-edged.
  blobs(ctx) {
    const balls = Array.from({ length: 5 + Math.floor(ctx.r() * 4) }, () => ({
      x: ctx.r(), y: ctx.r(), r: 0.08 + ctx.r() * 0.16,
    }));
    return (u, v) => {
      let f = 0;
      for (const b of balls) f += (b.r * b.r) / ((u - b.x) ** 2 + (v - b.y) ** 2 + 1e-4);
      const levels = [0.6, 1.2, 2.4, 4.8];
      let col = ctx.pal[0];
      for (let i = 0; i < levels.length; i++) {
        col = mix(col, ctx.pal[i + 1], smooth(levels[i] * 0.94, levels[i] * 1.06, f));
      }
      return col;
    };
  },
  // Diagonal stripes, inverted inside a circle.
  stripes(ctx) {
    const angle = ctx.r() * Math.PI, freq = 14 + ctx.r() * 18, cr = 0.22 + ctx.r() * 0.12;
    const cx = 0.3 + ctx.r() * 0.4, cy = 0.3 + ctx.r() * 0.4;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const [bg, a, b] = ctx.pal;
    return (u, v) => {
      const s = (u * ca + v * sa) * freq;
      const on = smooth(0.45, 0.55, Math.abs((s % 1 + 1) % 1 - 0.5) * 2);
      const inside = 1 - smooth(cr - ctx.px, cr + ctx.px, Math.hypot(u - cx, v - cy));
      const out = mix(bg, a, on), inn = mix(b, bg, on);
      return mix(out, inn, inside);
    };
  },
};

export const COVER_STYLES = Object.keys(PAINTERS);

/** A soft, faceless "portrait": a blurred gradient field with a single
 *  silhouette-like shape — reads as a press photo at thumbnail size without
 *  depicting anyone. */
function portraitPainter(ctx) {
  const [bg, a, b, c] = ctx.pal;
  const headY = 0.38 + ctx.r() * 0.06, headR = 0.13 + ctx.r() * 0.03;
  const glowX = ctx.r(), glowY = ctx.r() * 0.5;
  return (u, v) => {
    let col = mix(mix(bg, c, v * 0.6), a, Math.max(0, 1 - Math.hypot(u - glowX, v - glowY) * 1.4) * 0.8);
    const head = 1 - smooth(headR - ctx.px * 4, headR + ctx.px * 4, Math.hypot((u - 0.5) * 1.1, v - headY));
    const shoulderTop = 0.62 + 0.22 * ((u - 0.5) * 2) ** 2;
    const body = smooth(shoulderTop - ctx.px * 4, shoulderTop + ctx.px * 4, v);
    col = mix(col, mix(b, bg, 0.35), Math.max(head, body));
    return col;
  };
}

/**
 * Render `size`×`size` RGB pixels. Supersampled 2×2 for anti-aliasing, then a
 * light film grain so flat fields don't look like vector clip-art.
 */
export function paint(kind, seed, size = 600) {
  const r = rng(seed);
  const pal = PALETTES[Math.floor(r() * PALETTES.length)].map(hex);
  const ctx = { pal, r, px: 1 / size };
  let painter;
  if (kind === "portrait") painter = portraitPainter(ctx);
  else {
    const style = PAINTERS[kind] ? kind : COVER_STYLES[Math.floor(r() * COVER_STYLES.length)];
    painter = PAINTERS[style](ctx);
  }
  const grain = rng(`${seed}:grain`);
  const out = Buffer.alloc(size * size * 3);
  const step = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let R = 0, G = 0, B = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const c = painter((x + ox) * step, (y + oy) * step);
        R += c[0]; G += c[1]; B += c[2];
      }
      const n = (grain() - 0.5) * 10;
      const i = (y * size + x) * 3;
      out[i] = clamp(R / 4 + n);
      out[i + 1] = clamp(G / 4 + n);
      out[i + 2] = clamp(B / 4 + n);
    }
  }
  return { width: size, height: size, rgb: out };
}

const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode 8-bit RGB as PNG (filter 0 on every row; deflate does the rest). */
export function encodePng({ width, height, rgb }) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
