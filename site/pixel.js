// Pixel-art stadium renderer shared by the browser (canvas background) and the
// server (share preview PNGs). Everything is drawn through one function,
// r(x, y, w, h, color), in "logical" pixels that get scaled up crisply.

export const PALETTE = {
  grass1: "#3f8f3a",
  grass2: "#4a9e42",
  apron: "#2f6f2c",
  line: "#f4f4ec",
  endzoneA: "#b3262e",
  endzoneA2: "#c43a40",
  endzoneB: "#1d3f8a",
  endzoneB2: "#2a4f9e",
  ball: "#8a4b22",
  ballDark: "#6b3816",
  concrete: "#6b6f78",
  concrete2: "#5d616a",
  seat: "#454a55",
  wall: "#1e2430",
  board: "#0f141c",
  scoreText: "#ffd23f",
};

const SKIN = ["#f1c27d", "#e0ac69", "#c68642", "#8d5524", "#ffdbac", "#5a3a22"];
const HAIR = ["#2b1d14", "#4a3020", "#d9b26f", "#111111", "#7a4a2a", "#b5651d"];
const SHIRT = ["#c8102e", "#003594", "#ffb612", "#203731", "#4f2683", "#fb4f14", "#00338d", "#a71930",
  "#0085ca", "#f4f4f4", "#111111", "#97233f", "#006778", "#e31837", "#69be28", "#125740", "#d50a0a", "#ff8200"];
const ADS = ["#c8102e", "#ffb612", "#0085ca", "#69be28", "#fb4f14"];

/** Small deterministic PRNG so the crowd looks the same on every draw. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Fonts --------------------------------------------------------------------------
const DIGITS3 = {
  0: ["###", "#.#", "#.#", "#.#", "###"],
  1: [".#.", "##.", ".#.", ".#.", "###"],
  2: ["###", "..#", "###", "#..", "###"],
  3: ["###", "..#", ".##", "..#", "###"],
  4: ["#.#", "#.#", "###", "..#", "..#"],
  5: ["###", "#..", "###", "..#", "###"],
};

const G = (s) => s.match(/.{5}/g);
const FONT5 = {
  A: G(".###.#...##...#######...##...##...#"), B: G("####.#...##...#####.#...##...#####."),
  C: G(".###.#...##....#....#....#...#.###."), D: G("####.#...##...##...##...##...#####."),
  E: G("######....#....####.#....#....#####"), F: G("######....#....####.#....#....#...."),
  G: G(".###.#...##....#.####...##...#.####"), H: G("#...##...##...#######...##...##...#"),
  I: G(".###...#....#....#....#....#...###."), J: G("..###...#....#....#....#.#..#..##.."),
  K: G("#...##..#.#.#..##...#.#..#..#.#...#"), L: G("#....#....#....#....#....#....#####"),
  M: G("#...###.###.#.##.#.##...##...##...#"), N: G("#...##...###..##.#.##..###...##...#"),
  O: G(".###.#...##...##...##...##...#.###."), P: G("####.#...##...#####.#....#....#...."),
  Q: G(".###.#...##...##...##.#.##..#..##.#"), R: G("####.#...##...#####.#.#..#..#.#...#"),
  S: G(".#####....#.....###.....#....#####."), T: G("#####..#....#....#....#....#....#.."),
  U: G("#...##...##...##...##...##...#.###."), V: G("#...##...##...##...##...#.#.#...#.."),
  W: G("#...##...##...##.#.##.#.##.#.#.#.#."), X: G("#...##...#.#.#...#...#.#.#...##...#"),
  Y: G("#...##...#.#.#...#....#....#....#.."), Z: G("#####....#...#...#...#...#....#####"),
  0: G(".###.#...##..###.#.###..##...#.###."), 1: G("..#...##....#....#....#....#...###."),
  2: G(".###.#...#....#...#...#...#...#####"), 3: G("#####...#...#.....#.....##...#.###."),
  4: G("...#...##..#.#.#..#.#####...#....#."), 5: G("######....####.....#....##...#.###."),
  6: G("..##..#...#....####.#...##...#.###."), 7: G("#####....#...#...#...#....#....#..."),
  8: G(".###.#...##...#.###.#...##...#.###."), 9: G(".###.#...##...#.####....#...#..##.."),
  "#": G(".#.#..#.#.#####.#.#.#####.#.#..#.#."), "/": G("....#....#...#...#...#...#....#...."),
  ":": G(".......#....#.........#....#......."), ".": G("..............................##..."),
  "!": G("..#....#....#....#....#.........#.."), "?": G(".###.#...#....#...#...#.........#.."),
  "-": G("...............#####..............."), "'": G("..#....#...#......................."),
  "+": G(".......#....#..#####..#....#......."),
  "&": G(".##..#..#.#.#...#...#.#.##..#..##.#"),
  " ": G("..................................."),
};

/** Width in logical pixels of text drawn with the 5x7 font at `scale`. */
export function textWidth(str, scale = 1) {
  return str.length ? (str.length * 6 - 1) * scale : 0;
}

export function drawText(r, str, x, y, color, scale = 1) {
  let cx = x;
  for (const ch of str.toUpperCase()) {
    const g = FONT5[ch] || FONT5["?"];
    g.forEach((row, gy) => {
      for (let gx = 0; gx < 5; gx++) if (row[gx] === "#") r(cx + gx * scale, y + gy * scale, scale, scale, color);
    });
    cx += 6 * scale;
  }
}

function drawDigits3(r, str, x, y, color) {
  let cx = x;
  for (const ch of str) {
    DIGITS3[ch].forEach((row, gy) => {
      for (let gx = 0; gx < 3; gx++) if (row[gx] === "#") r(cx + gx, y + gy, 1, 1, color);
    });
    cx += 4;
  }
}

// ---- Field --------------------------------------------------------------------------
/**
 * Draw a football field in the box (x, y, w, h). `vertical` runs the yard
 * lines across the box (end zones at top and bottom); otherwise end zones are
 * left and right. Midfield sits at the box's center; `yard` is pixels per yard.
 */
export function drawField(r, x, y, w, h, { vertical = true, yard = 3 } = {}) {
  const L = vertical ? h : w; // along the field
  const Wd = vertical ? w : h; // across the field
  // Map (along, across, alongLen, acrossLen) into screen space.
  const R = (a, c, la, lc, color) => {
    const a0 = Math.max(0, Math.round(a));
    const a1 = Math.min(L, Math.round(a + la));
    if (a1 <= a0) return;
    if (vertical) r(x + c, y + a0, lc, a1 - a0, color);
    else r(x + a0, y + c, a1 - a0, lc, color);
  };
  const mid = L / 2;
  const at = (yd) => mid + (yd - 50) * yard;

  R(0, 0, L, Wd, PALETTE.apron);
  const m = Math.max(2, Math.round(Wd * 0.04)); // apron between sideline and stands
  const inner0 = m + 1;
  const innerW = Wd - 2 * m - 2;

  // Grass stripes every 5 yards, end zones, and grass beyond the end lines.
  for (let yd = 0; yd < 100; yd += 5) R(at(yd), inner0, 5 * yard, innerW, (yd / 5) % 2 ? PALETTE.grass1 : PALETTE.grass2);
  for (const [start, c1, c2] of [[-10, PALETTE.endzoneA, PALETTE.endzoneA2], [100, PALETTE.endzoneB, PALETTE.endzoneB2]]) {
    R(at(start), inner0, 10 * yard, innerW, c1);
    // Diagonal stripes in the end zone.
    for (let a = 0; a < 10 * yard; a++) {
      for (let c = 0; c < innerW; c++) if ((a + c) % 8 < 2) R(at(start) + a, inner0 + c, 1, 1, c2);
    }
  }
  // Sidelines and end lines.
  R(at(-10), m, 120 * yard, 1, PALETTE.line);
  R(at(-10), Wd - m - 1, 120 * yard, 1, PALETTE.line);
  R(at(-10), m, 1, Wd - 2 * m, PALETTE.line);
  R(at(110), m, 1, Wd - 2 * m, PALETTE.line);

  // Yard lines every 5 yards, hash marks every yard.
  const hashA = Math.round(Wd * 0.4);
  const hashB = Math.round(Wd * 0.6) - 2;
  for (let yd = 0; yd <= 100; yd++) {
    const a = at(yd);
    if (yd % 5 === 0) R(a, inner0, 1, innerW, PALETTE.line);
    else {
      R(a, inner0 + 1, 1, 2, PALETTE.line);
      R(a, inner0 + innerW - 3, 1, 2, PALETTE.line);
      R(a, hashA, 1, 2, PALETTE.line);
      R(a, hashB, 1, 2, PALETTE.line);
    }
  }

  // Yard numbers (upright, beside each 10-yard line).
  if (innerW >= 30 && yard >= 2) {
    for (let yd = 10; yd <= 90; yd += 10) {
      const label = String(yd <= 50 ? yd : 100 - yd);
      const a = at(yd);
      const nW = label.length * 4 - 1;
      for (const c of [inner0 + 5, inner0 + innerW - 5 - (vertical ? nW : 5)]) {
        if (vertical) drawDigits3(r, label, x + c, y + Math.round(a - (yd < 50 ? 7 : -3)), PALETTE.line);
        else drawDigits3(r, label, x + Math.round(a - nW / 2), y + c, PALETTE.line);
      }
    }
  }

  // Midfield logo: a pixel football.
  const ball = ["..####..", ".######.", "##.#.#.#", "##.....#", ".######.", "..####.."];
  const laces = ["........", "........", "..#.#.#.", "..#####.", "........", "........"];
  const bw = 8, bh = 6;
  const cx = vertical ? Math.round(Wd / 2 - bw / 2) : Math.round(mid - bw / 2);
  const cy = vertical ? Math.round(mid - bh / 2) : Math.round(Wd / 2 - bh / 2);
  for (let j = 0; j < bh; j++) {
    for (let i = 0; i < bw; i++) {
      const color = laces[j][i] === "#" ? PALETTE.line : ball[j][i] === "#" ? (j >= 4 ? PALETTE.ballDark : PALETTE.ball) : null;
      if (color) r(x + cx + i, y + cy + j, 1, 1, color);
    }
  }
}

// ---- Stands ---------------------------------------------------------------------------
const FAN_W = 4;
const FAN_H = 6;

/**
 * Draw a crowd in the box (x, y, w, h). `side` is where the stands sit
 * relative to the field ("left", "right", "top", "bottom"); the wall faces the
 * field. `wave` (0..1 along the stands, or null) raises arms for a crowd wave.
 */
export function drawStands(r, x, y, w, h, { side = "left", seed = 1, wave = null } = {}) {
  const vertical = side === "left" || side === "right";
  const wallT = 3;
  // Wall with ad boards along the field edge.
  const wall = side === "left" ? [x + w - wallT, y, wallT, h] : side === "right" ? [x, y, wallT, h]
    : side === "top" ? [x, y + h - wallT, w, wallT] : [x, y, w, wallT];
  // Crowd area (everything except the wall).
  const crowd = side === "left" ? [x, y, w - wallT, h] : side === "right" ? [x + wallT, y, w - wallT, h]
    : side === "top" ? [x, y, w, h - wallT] : [x, y + wallT, w, h - wallT];

  const [cx, cy, cw, ch] = crowd;
  r(cx, cy, cw, ch, PALETTE.concrete2);
  const rand = rng(seed);
  const rows = Math.ceil(ch / FAN_H);
  const cols = Math.ceil(cw / FAN_W);
  const len = vertical ? rows : cols; // positions along the field, for the wave
  for (let j = 0; j < rows; j++) {
    const ry = cy + j * FAN_H;
    r(cx, ry + FAN_H - 1, cw, 1, j % 2 ? PALETTE.concrete : PALETTE.seat); // step
    for (let i = 0; i < cols; i++) {
      const fx = cx + i * FAN_W;
      const empty = rand() < 0.06;
      const skin = SKIN[(rand() * SKIN.length) | 0];
      const hair = HAIR[(rand() * HAIR.length) | 0];
      const shirt = SHIRT[(rand() * SHIRT.length) | 0];
      const hasHair = rand() < 0.7;
      if (empty) {
        r(fx + 1, ry + 3, 2, 2, PALETTE.seat);
        continue;
      }
      const along = (vertical ? j : i) / Math.max(1, len - 1);
      const up = wave != null && Math.abs(along - wave) < 0.06;
      const dy = up ? -1 : 0;
      r(fx + 1, ry + 1 + dy, 2, 2, skin); // head
      if (hasHair) r(fx + 1, ry + 1 + dy, 2, 1, hair);
      r(fx, ry + 3 + dy, 4, 2 - dy, shirt); // body
      if (up) {
        r(fx, ry, 1, 3, skin); // arms up
        r(fx + 3, ry, 1, 3, skin);
      }
    }
  }
  // Wall and ad boards.
  const [wx, wy, ww, wh] = wall;
  r(wx, wy, ww, wh, PALETTE.wall);
  const boardLen = 14;
  const span = vertical ? wh : ww;
  for (let k = 0, b = 0; k < span; k += boardLen + 2, b++) {
    const color = ADS[b % ADS.length];
    if (vertical) r(wx + 1, wy + k + 1, ww - 2, Math.min(boardLen, span - k - 1), color);
    else r(wx + k + 1, wy + 1, Math.min(boardLen, span - k - 1), wh - 2, color);
  }
}
