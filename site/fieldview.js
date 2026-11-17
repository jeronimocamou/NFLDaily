// The broadcast view of the drive: a horizontal pixel field with the ball,
// the line of scrimmage (blue) and the first-down line (yellow). Plays are
// animated: bigger gains cover more ground, faster.
import { PALETTE, drawField, drawText } from "./pixel.js";

const YARD = 2; // art pixels per yard
const W = 248; // 120 yards plus a little apron at each end
const H = 50;
const LOS = "#4aa3ff";
const FIRST = "#ffd23f";
const ease = (t) => 1 - Math.pow(1 - t, 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createFieldView(canvas) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: false });
  const base = document.createElement("canvas");
  base.width = W;
  base.height = H;
  const bctx = base.getContext("2d");
  const fill = (c) => (x, y, w, h, color) => {
    c.fillStyle = color;
    c.fillRect(x, y, w, h);
  };
  drawField(fill(bctx), 0, 0, W, H, { vertical: false, yard: YARD });
  const r = fill(ctx);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  // Own goal line on the left, their goal line on the right.
  const xOf = (yl) => Math.round(W / 2 + (yl - 50) * YARD);
  const mid = Math.round(H / 2);
  const top = 3;
  const bottom = H - 3;

  let state = { yl: 25, toGo: 10, showFirst: true };

  function ball(x, y, color = PALETTE.ball) {
    r(x - 2, y - 1, 5, 3, color);
    r(x - 1, y - 2, 3, 1, color);
    r(x - 1, y + 2, 3, 1, PALETTE.ballDark);
    r(x - 1, y, 3, 1, PALETTE.line); // laces
  }

  function frame({ yl, toGo, ballX = xOf(yl), ballY = mid, trail = null, flash = null, showFirst = true }) {
    ctx.drawImage(base, 0, 0);
    if (flash) r(flash.x, top, flash.w, bottom - top, flash.color);
    r(xOf(yl), top, 1, bottom - top, LOS);
    if (showFirst && toGo && yl + toGo < 100) r(xOf(yl + toGo), top, 1, bottom - top, FIRST);
    if (trail) {
      const [a, b, color] = trail;
      for (let x = Math.min(a, b); x <= Math.max(a, b); x += 3) r(x, mid, 1, 1, color);
    }
    ball(Math.round(ballX), Math.round(ballY));
  }

  function draw(s) {
    state = { yl: s.yl, toGo: s.toGo, showFirst: s.phase !== "pat_choice" && s.phase !== "over" };
    frame(state);
  }

  function tween(ms, step) {
    if (reduceMotion.matches) {
      step(1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = (t) => {
        const p = Math.min(1, (t - start) / ms);
        step(p);
        if (p < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  /** Animate a play from the old state to the new one. */
  // Big pixel text with a dark outline, centered on x (art pixels).
  function callout(text, x, color, scale = 2) {
    const w = (text.length * 6 - 1) * scale;
    const cx = Math.max(2, Math.min(W - w - 2, Math.round(x - w / 2)));
    const cy = Math.round(mid - 3.5 * scale);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
      drawText(r, text, cx + dx, cy + dy, PALETTE.board, scale);
    }
    drawText(r, text, cx, cy, color, scale);
  }

  const TIER_COLOR = { check: "#ffd23f", seam: "#5ef08a", bomb: "#ff9a3c" };
  const tierOf = (rarity) => (rarity >= 0.75 ? "bomb" : rarity >= 0.4 ? "seam" : "check");

  /** A pass: drop back, the ball flies on an arc (higher and longer for deeper throws). */
  async function throwBall(old, fromX, toX, peak, ms, { drop = 0, bounce = false } = {}) {
    const qbX = fromX - 6;
    await tween(180, (p) => frame({ ...old, ballX: fromX + (qbX - fromX) * p }));
    await tween(ms, (p) => {
      const e = ease(p);
      const x = qbX + (toX - qbX) * e;
      const y = mid - Math.sin(Math.PI * p) * peak + drop * p * p;
      frame({ ...old, ballX: x, ballY: y });
      r(Math.round(x) - 1, mid + 4, 3, 1, "#1b4d1a"); // shadow on the grass
    });
    if (bounce) {
      const x0 = toX;
      await tween(320, (p) => frame({ ...old, ballX: x0 + 6 * p, ballY: mid + drop - Math.abs(Math.sin(Math.PI * 2 * p)) * 4 }));
    }
  }

  async function hold(ms) {
    await sleep(reduceMotion.matches ? 0 : ms);
  }

  /** Animate a play from the old state to the new one. */
  async function animate(event, before, after) {
    const fromX = xOf(before.yl);
    const old = { yl: before.yl, toGo: before.toGo };

    if (!event.yards) {
      // Incomplete: the ball sails, hits the turf and bounces away.
      await throwBall(old, fromX, fromX + 24, 8, 520, { drop: 10, bounce: true });
      frame(old);
      callout(event.timedOut ? "TIME" : "INC", fromX + 20, "#f4f4ec");
      await hold(650);
      draw(after);
      return;
    }

    // A completion: deeper throws fly higher, farther and faster.
    const tier = tierOf(event.rarity);
    const toX = xOf(after.yl);
    const peak = { check: 5, seam: 11, bomb: 18 }[tier];
    const ms = { check: 520, seam: 620, bomb: 760 }[tier];
    await throwBall(old, fromX, toX, peak, ms);
    // The catch: a burst of white pixels, then the yardage callout.
    for (const [dx, dy] of [[-3, -3], [3, -3], [-3, 3], [3, 3], [0, -4], [0, 4], [-4, 0], [4, 0]]) r(toX + dx, mid + dy, 1, 1, PALETTE.line);
    if (event.td) {
      await flashEnd(PALETTE.scoreText, "TD");
      frame({ yl: 99, toGo: 0, showFirst: false, ballX: xOf(105) });
      callout("TOUCHDOWN", W / 2, PALETTE.scoreText);
      await hold(1100);
      draw(after);
      return;
    }
    callout(`+${event.yards}`, toX, TIER_COLOR[tier], tier === "bomb" ? 3 : 2);
    await hold(tier === "bomb" ? 900 : 650);
    if (event.firstDown) {
      draw(after);
      const fx = xOf(Math.min(after.yl + after.toGo, 99));
      for (let i = 0; i < 2; i++) {
        r(fx - 1, top, 3, bottom - top, FIRST);
        callout("1ST DOWN", (toX + fx) / 2, FIRST, 1);
        await hold(220);
        draw(after);
        await hold(120);
      }
    }
    draw(after);
  }

  async function flashEnd(color, text) {
    const x = xOf(100) + 1;
    for (let i = 0; i < 3; i++) {
      frame({ ...state, yl: Math.min(state.yl, 99), showFirst: false, flash: { x, w: 10 * YARD - 1, color } });
      drawText(r, text, x + Math.round((10 * YARD - text.length * 6) / 2), mid - 3, PALETTE.board, 1);
      await hold(160);
      frame({ ...state, yl: Math.min(state.yl, 99), showFirst: false });
      await hold(110);
    }
  }

  draw({ yl: 25, toGo: 10, phase: "ready" });
  return { draw, animate };
}
