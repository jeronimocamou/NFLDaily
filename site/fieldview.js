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
  async function animate(event, before, after) {
    const fromX = xOf(before.yl);
    const old = { yl: before.yl, toGo: before.toGo };
    if (event.kind === "fg") {
      // The kick flies toward the goal posts; a miss hooks wide.
      const postX = xOf(110) - 2;
      await tween(900, (p) => {
        const e = ease(p);
        const x = fromX + (postX - fromX) * e;
        const drift = event.good ? 0 : (mid - top - 4) * p * p;
        frame({ ...old, ballX: x, ballY: mid - Math.sin(Math.PI * e) * 10 - drift });
        r(postX, mid - 9, 1, 18, FIRST);
      });
      if (event.good) await flashEnd(PALETTE.scoreText, "GOOD");
      frame({ ...old, showFirst: false });
      return;
    }
    if (event.kind === "pat1" || event.kind === "pat2") {
      if (event.good) await flashEnd(PALETTE.scoreText, event.kind === "pat1" ? "+1" : "+2");
      draw(after);
      return;
    }
    if (event.delay || event.yards < 0) {
      // Sack or penalty: the ball gets pushed back.
      const toX = xOf(after.yl);
      await tween(500, (p) => frame({ ...old, ballX: fromX + (toX - fromX) * ease(p), trail: [fromX, fromX + (toX - fromX) * p, "#e04848"] }));
      await sleep(150);
      draw(after);
      return;
    }
    if (event.yards === 0) {
      // Incomplete: the pass sails and falls short, ball comes back.
      await tween(650, (p) => {
        const x = fromX + Math.sin(Math.PI * p) * 18;
        frame({ ...old, ballX: x, ballY: mid - Math.sin(Math.PI * p) * 8 });
      });
      draw(after);
      return;
    }
    // A gain: the better the play, the faster the ball moves downfield.
    const toX = xOf(after.yl);
    const ms = 450 + event.yards * 22;
    await tween(ms, (p) => {
      const x = fromX + (toX - fromX) * ease(p);
      frame({ ...old, ballX: x, trail: [fromX, x, PALETTE.line] });
    });
    if (event.td) await flashEnd(PALETTE.scoreText, "TD");
    else if (event.firstDown) await sleep(120);
    draw(after);
  }

  async function flashEnd(color, text) {
    const x = xOf(100) + 1;
    for (let i = 0; i < 3; i++) {
      frame({ ...state, yl: Math.min(state.yl, 99), showFirst: false, flash: { x, w: 10 * YARD - 1, color } });
      drawText(r, text, x + Math.round((10 * YARD - text.length * 6) / 2), mid - 3, PALETTE.board, 1);
      await sleep(reduceMotion.matches ? 0 : 160);
      frame({ ...state, yl: Math.min(state.yl, 99), showFirst: false });
      await sleep(reduceMotion.matches ? 0 : 110);
    }
  }

  draw({ yl: 25, toGo: 10, phase: "ready" });
  return { draw, animate };
}
