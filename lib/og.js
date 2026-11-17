// Share preview images (1200x630 PNG), drawn with the same pixel engine as the
// site background and encoded with a tiny dependency-free PNG writer.
import { deflateSync } from "node:zlib";
import { PALETTE, drawField, drawStands, drawText, textWidth } from "../site/pixel.js";

const W = 240; // logical pixels
const H = 126;
const SCALE = 5; // -> 1200 x 630

// Share code: number-points-yards-plays-playCodes[-sStreak], e.g. 17-7-75-5-bgwmt-s4
export const SHARE_CODE_RE = /^(\d{1,4})-(\d)-(-?\d{1,2})-(\d{1,3})-([gmwbtkxpq]{1,40})(?:-s(\d{1,4}))?$/;
const CODE_COLOR = {
  g: ["#2fbf5f", "#1f8a45"], m: ["#e8b923", "#b08a10"], w: ["#e04848", "#a83030"], b: ["#ff8a1f", "#c45f00"],
  t: ["#8a4b22", "#6b3816"], k: ["#2fbf5f", "#1f8a45"], x: ["#e04848", "#a83030"], p: ["#2fbf5f", "#1f8a45"], q: ["#e04848", "#a83030"],
};
const CODE_YARDS = { m: 10, g: 20, b: 40, w: 0 };

export function parseShareCode(code) {
  const m = SHARE_CODE_RE.exec(code || "");
  if (!m) return null;
  const [points, yards, plays] = [Number(m[2]), Number(m[3]), Number(m[4])];
  if (![0, 7].includes(points) || yards > 75 || yards < -24 || plays > 40) return null;
  return { number: Number(m[1]), points, yards, plays, codes: m[5], streak: m[6] ? Number(m[6]) : 0 };
}

/** Ball spot (yards from own goal) after each play, for drawing the drive path. */
export function drivePath(share) {
  const start = 25;
  const end = start + share.yards;
  const raw = [start];
  for (const c of share.codes) raw.push(c === "t" ? 100 : Math.min(99, raw.at(-1) + (CODE_YARDS[c] ?? 0)));
  // Older links used other yardages: scale so the path ends where the drive did.
  const span = raw.at(-1) - start;
  return raw.map((y) => (span > 0 ? Math.round(start + ((y - start) * (end - start)) / span) : y));
}

export function shareLabel(share) {
  return share.points >= 6 ? "TOUCHDOWN" : "NO SCORE";
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawFlame(r, x, y) {
  const rows = ["..#..", ".###.", "#####", "##*##", ".#*#."];
  rows.forEach((row, j) => [...row].forEach((ch, i) => {
    if (ch === "#") r(x + i, y + j, 1, 1, "#ff6b1a");
    if (ch === "*") r(x + i, y + j, 1, 1, "#ffd23f");
  }));
}

function drawCard(r, share) {
  const center = (str, y, color, scale) => drawText(r, str, Math.round(W / 2 - textWidth(str, scale) / 2), y, color, scale);
  // Crowd behind, then the field with the drive drawn on it.
  drawStands(r, 0, 0, W, 64, { side: "top", seed: 3 });
  drawField(r, 0, 64, W, 48, { vertical: false, yard: 2 });
  drawStands(r, 0, 112, W, 14, { side: "bottom", seed: 5 });
  const xOf = (yl) => Math.round(W / 2 + (yl - 50) * 2);
  const fy = 88;

  if (share) {
    const path = drivePath(share);
    // Line of scrimmage at the start, then each play as a colored segment.
    r(xOf(25), 66, 1, 44, "#4aa3ff");
    share.codes.split("").forEach((c, k) => {
      const [col] = CODE_COLOR[c] || CODE_COLOR.w;
      const a = xOf(path[k]), b = xOf(path[k + 1]);
      if (b > a) {
        r(a, fy - 1, b - a, 3, "#0f141c");
        r(a, fy, b - a, 1, col);
        r(b - 1, fy - 2, 2, 5, col); // catch marker
      } else {
        r(a - 1, fy - 6, 3, 3, CODE_COLOR.w[0]); // incomplete
      }
    });
    const bx = xOf(Math.min(path.at(-1), 104));
    r(bx - 2, fy - 1, 5, 3, PALETTE.ball);
    r(bx - 1, fy, 3, 1, PALETTE.line);
    if (share.points) drawText(r, "TD", xOf(105) - 5, fy - 10, PALETTE.scoreText, 1);
  }

  // Scoreboard panel over the crowd.
  const px = 20, py = 5, pw = 200, ph = 55;
  r(px - 2, py - 2, pw + 4, ph + 4, "#000000");
  r(px, py, pw, ph, PALETTE.board);
  r(px + 2, py + 2, pw - 4, 1, PALETTE.scoreText);
  r(px + 2, py + ph - 3, pw - 4, 1, PALETTE.scoreText);
  if (!share) {
    center("FOURTH & DAILY", py + 9, PALETTE.scoreText, 2);
    center("DAILY FOOTBALL TRIVIA", py + 28, "#f4f4ec", 1);
    center("NAME ANSWERS. DRIVE THE FIELD.", py + 38, "#f4f4ec", 1);
    return;
  }
  center(`FOURTH & DAILY #${share.number}`, py + 6, PALETTE.scoreText, 1);
  center(shareLabel(share), py + 15, "#f4f4ec", 2);
  const result = share.points ? `WON 24-21 IN ${share.plays} PLAYS` : `${share.yards} YDS IN ${share.plays} PLAYS`;
  center(result, py + 32, PALETTE.scoreText, 1);
  // Play squares, then the streak.
  const codes = share.codes.slice(0, 18).split("");
  const size = 6, gap = 2;
  const streakW = share.streak > 1 ? 8 + textWidth(String(share.streak), 1) : 0;
  const total = codes.length * (size + gap) - gap + streakW;
  let sx = Math.round(W / 2 - total / 2);
  const sy = py + 42;
  for (const t of codes) {
    const [c, dark] = CODE_COLOR[t] || CODE_COLOR.w;
    r(sx, sy, size, size, c);
    r(sx, sy + size - 1, size, 1, dark);
    if (t === "t") r(sx + 1, sy + 2, 4, 1, "#f4f4ec");
    else if (t === "b") { r(sx + 2, sy + 2, 2, 2, "#0f141c"); r(sx + 4, sy + 1, 1, 1, "#ffd23f"); }
    else if (t === "w") { r(sx + 1, sy + 1, 1, 1, "#ffffff"); r(sx + 4, sy + 4, 1, 1, "#ffffff"); r(sx + 2, sy + 2, 2, 2, "#ffffff"); }
    else r(sx + 1, sy + 1, 1, 1, "#ffffff");
    sx += size + gap;
  }
  if (streakW) {
    drawFlame(r, sx + 1, sy);
    drawText(r, String(share.streak), sx + 8, sy - 1, "#ff9a3c", 1);
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
