// Share preview images (1200x630 PNG), drawn with the same pixel engine as the
// site background and encoded with a tiny dependency-free PNG writer.
import { deflateSync } from "node:zlib";
import { PALETTE, drawField, drawStands, drawText, textWidth } from "../site/pixel.js";

const W = 240; // logical pixels
const H = 126;
const SCALE = 5; // -> 1200 x 630

export const SHARE_CODE_RE = /^(\d{1,4})-(\d{1,3})-([gmlb]{5})$/;
const TIER_COLOR = { g: ["#2fbf5f", "#1f8a45"], m: ["#e8b923", "#b08a10"], l: ["#ef8a2e", "#b8641c"], b: ["#e04848", "#a83030"] };

export function parseShareCode(code) {
  const m = SHARE_CODE_RE.exec(code || "");
  if (!m) return null;
  const score = Number(m[2]);
  if (score > 500) return null;
  return { number: Number(m[1]), score, grid: m[3] };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawCard(r, share) {
  // Stands top and bottom, field across the middle.
  drawStands(r, 0, 0, W, 26, { side: "top", seed: 3 });
  drawField(r, 0, 26, W, 74, { vertical: false, yard: 2 });
  drawStands(r, 0, 100, W, 26, { side: "bottom", seed: 5 });

  // Scoreboard panel.
  const px = 20, py = 31, pw = 200, ph = 64;
  r(px - 2, py - 2, pw + 4, ph + 4, "#000000");
  r(px, py, pw, ph, PALETTE.board);
  r(px + 2, py + 2, pw - 4, 1, PALETTE.scoreText);
  r(px + 2, py + ph - 3, pw - 4, 1, PALETTE.scoreText);
  const center = (str, y, color, scale) => drawText(r, str, Math.round(W / 2 - textWidth(str, scale) / 2), y, color, scale);

  center("FOURTH & DAILY", py + 7, PALETTE.scoreText, 2);
  const squares = share ? share.grid.split("") : ["g", "g", "m", "g", "l"];
  if (share) {
    center(`#${share.number}  ${share.score}/500`, py + 27, "#f4f4ec", 2);
  } else {
    center("DAILY FOOTBALL TRIVIA", py + 26, "#f4f4ec", 1);
    center("5 QUESTIONS. EVERY DAY.", py + 35, "#f4f4ec", 1);
  }
  const size = 9, gap = 4;
  const total = squares.length * size + (squares.length - 1) * gap;
  let sx = Math.round(W / 2 - total / 2);
  const sy = py + 46;
  for (const t of squares) {
    const [c, dark] = TIER_COLOR[t];
    r(sx, sy, size, size, c);
    r(sx, sy + size - 2, size, 2, dark);
    r(sx + 1, sy + 1, 2, 1, "#ffffff");
    sx += size + gap;
  }
}

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode an RGB pixel buffer (w x h logical pixels) as a PNG, scaled up `scale`x. */
export function encodePng(pixels, w, h, scale) {
  const OW = w * scale, OH = h * scale;
  const raw = Buffer.alloc((OW * 3 + 1) * OH);
  for (let y = 0; y < OH; y++) {
    const row = y * (OW * 3 + 1);
    raw[row] = 0; // no filter
    const sy = Math.floor(y / scale);
    for (let x = 0; x < OW; x++) {
      const s = (sy * w + Math.floor(x / scale)) * 3;
      const o = row + 1 + x * 3;
      raw[o] = pixels[s]; raw[o + 1] = pixels[s + 1]; raw[o + 2] = pixels[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(OW, 0);
  ihdr.writeUInt32BE(OH, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A drawing surface: returns { pixels, r } where r(x, y, w, h, color) fills. */
export function surface(w, h) {
  const pixels = new Uint8Array(w * h * 3);
  const r = (x, y, rw, rh, color) => {
    const [cr, cg, cb] = hexToRgb(color);
    for (let j = Math.max(0, y); j < Math.min(h, y + rh); j++) {
      for (let i = Math.max(0, x); i < Math.min(w, x + rw); i++) {
        const o = (j * w + i) * 3;
        pixels[o] = cr; pixels[o + 1] = cg; pixels[o + 2] = cb;
      }
    }
  };
  return { pixels, r };
}

/** Render the share card. `share` = { number, score, grid } or null for the generic card. */
export function renderOgPng(share = null) {
  const { pixels, r } = surface(W, H);
  drawCard(r, share);
  return encodePng(pixels, W, H, SCALE);
}

/** The app icon: a pixel football on a field, with "4TH" on a scoreboard. */
export function renderIconPng(scale) {
  const N = 64;
  const { pixels, r } = surface(N, N);
  r(0, 0, N, N, PALETTE.board);
  r(6, 6, N - 12, N - 12, PALETTE.grass2);
  for (let x = 6; x < N - 6; x += 10) r(x, 6, 5, N - 12, PALETTE.grass1);
  for (const x of [16, 31, 46]) r(x, 6, 1, N - 12, PALETTE.line);
  r(14, 11, 36, 18, PALETTE.board);
  drawText(r, "4TH", Math.round(N / 2 - textWidth("4TH", 2) / 2), 13, PALETTE.scoreText, 2);
  const ball = ["..####..", ".######.", "##.#.#.#", "##.....#", ".######.", "..####.."];
  const laces = ["........", "........", "..#.#.#.", "..#####.", "........", "........"];
  const s = 3, bx = Math.round(N / 2 - 12), by = 34;
  for (let j = 0; j < 6; j++) {
    for (let i = 0; i < 8; i++) {
      const c = laces[j][i] === "#" ? PALETTE.line : ball[j][i] === "#" ? (j >= 4 ? PALETTE.ballDark : PALETTE.ball) : null;
      if (c) r(bx + i * s, by + j * s, s, s, c);
    }
  }
  return encodePng(pixels, N, N, scale);
}
