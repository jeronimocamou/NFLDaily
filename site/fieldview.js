// The broadcast view of the drive: a horizontal pixel field with your team's
// end zone on the left and today's opponent's on the right, the line of
// scrimmage (blue) and the first-down line (yellow), and three tiny players:
// your QB and receiver (in your team's colors) and a defender (theirs).
// Every play is animated: the receiver runs a route, the ball flies to him
// (higher, longer and faster for deeper answers), and the result pops up.
import { PALETTE, drawField, drawText } from "./pixel.js";

const YARD = 2; // art pixels per yard
const W = 248; // 120 yards plus a little apron at each end
const H = 50;
const LOS = "#4aa3ff";
const FIRST = "#ffd23f";
const ease = (t) => 1 - Math.pow(1 - t, 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lerp = (a, b, t) => a + (b - a) * t;

const TIER_COLOR = { check: "#ffd23f", seam: "#5ef08a", bomb: "#ff9a3c" };
const tierOf = (rarity) => (rarity >= 0.75 ? "bomb" : rarity >= 0.4 ? "seam" : "check");
const CONFETTI = ["#ffd23f", "#ff6b5a", "#5ef08a", "#4aa3ff", "#f4f4ec", "#ff9a3c"];

/**
 * hooks: { onSnap, onCatch(tier), onIncomplete, onFirstDown, onTouchdown, onBomb }
 * (sounds and screen effects live in the app; the field just calls these).
 */
export function createFieldView(canvas, hooks = {}) {
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
  const r = fill(ctx);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const call = (name, ...args) => hooks[name]?.(...args);

  let teams = {
    mine: { code: "", c1: "#1d3f8a", c2: "#f4f4ec" },
    them: { code: "", c1: "#b3262e", c2: "#f4f4ec" },
  };
  let speed = 1;

  function paintBase() {
    drawField(fill(bctx), 0, 0, W, H, {
      vertical: false,
      yard: YARD,
      logo: false, // the only football on this field is the real one
      ends: [
        { c1: teams.mine.c1, c2: shade(teams.mine.c1), label: teams.mine.code },
        { c1: teams.them.c1, c2: shade(teams.them.c1), label: teams.them.code },
      ],
    });
  }
  paintBase();

  // Own goal line on the left, their goal line on the right.
  const xOf = (yl) => Math.round(W / 2 + (yl - 50) * YARD);
  const mid = Math.round(H / 2);
  const top = 3;
  const bottom = H - 3;

  let state = { yl: 25, toGo: 10, showFirst: true };

  function ball(x, y) {
    x = Math.round(x);
    y = Math.round(y);
    r(x - 2, y - 1, 5, 3, PALETTE.ball);
    r(x - 1, y - 2, 3, 1, PALETTE.ball);
    r(x - 1, y + 2, 3, 1, PALETTE.ballDark);
    r(x - 1, y, 3, 1, PALETTE.line); // laces
  }

  /** A tiny player standing at (x, feet y). pose: stand | run0 | run1 | up | jump */
  function player(x, y, team, pose = "stand") {
    x = Math.round(x);
    y = Math.round(y) - (pose === "jump" ? 3 : 0);
    const { c1, c2 } = team;
    r(x - 1, y - 9, 3, 2, c2); // helmet
    r(x - 2, y - 7, 5, 3, c1); // jersey
    r(x, y - 6, 1, 1, c2); // number
    r(x - 1, y - 4, 3, 1, "#e6e6e6"); // pants
    if (pose === "run1") {
      r(x - 2, y - 3, 1, 3, c2);
      r(x + 2, y - 3, 1, 3, c2);
    } else {
      r(x - 1, y - 3, 1, 3, c2);
      r(x + 1, y - 3, 1, 3, c2);
    }
    if (pose === "up" || pose === "jump") {
      r(x - 3, y - 11, 1, 4, c1);
      r(x + 3, y - 11, 1, 4, c1);
    }
  }

  function scene({ yl, toGo, showFirst = true, flash = null }) {
    ctx.drawImage(base, 0, 0);
    if (flash) r(flash.x, top, flash.w, bottom - top, flash.color);
    r(xOf(yl), top, 1, bottom - top, LOS);
    if (showFirst && toGo && yl + toGo < 100) r(xOf(yl + toGo), top, 1, bottom - top, FIRST);
  }

  /** Formation at the line: QB behind the ball, receiver split wide, defender across. */
  function formation(s) {
    const x = xOf(s.yl);
    scene(s);
    player(x + 12, mid - 8, teams.them);
    player(x + 2, mid - 10, teams.mine);
    player(x - 5, mid + 9, teams.mine);
    ball(x, mid + 4);
  }

  function draw(s) {
    state = { yl: s.yl, toGo: s.toGo, showFirst: s.phase !== "over" };
    formation(state);
  }

  function tween(ms, step) {
    if (reduceMotion.matches) {
      step(1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const start = performance.now();
      const dur = ms * speed;
      const tick = (t) => {
        const p = Math.min(1, (t - start) / dur);
        step(p, t);
        if (p < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  const hold = (ms) => sleep(reduceMotion.matches ? 0 : ms * speed);
  const legs = (t) => (Math.floor(t / 70) % 2 ? "run1" : "run0");

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

  /** A pass play: drop back, receiver runs his route, ball in the air, then the catch (or not). */
  async function passPlay(old, toX, { peak, ms, complete }) {
    const x0 = xOf(old.yl);
    const qb = { x: x0 - 5, y: mid + 9 };
    const wr0 = { x: x0 + 2, y: mid - 10 };
    const db0 = { x: x0 + 12, y: mid - 8 };
    const catchAt = complete ? { x: toX, y: mid - 2 } : { x: x0 + 22, y: mid - 12 };
    const dbEnd = complete ? { x: toX - 7, y: mid + 2 } : { x: catchAt.x + 2, y: catchAt.y + 1 };
    const total = 180 + ms;
    const drop = 180 / total;
    await tween(total, (p, t) => {
      scene(old);
      const run = ease(p);
      const wx = lerp(wr0.x, catchAt.x, run);
      const wy = lerp(wr0.y, catchAt.y, Math.min(1, p * 1.4));
      const dx = lerp(db0.x, dbEnd.x, Math.pow(p, 1.15));
      const dy = lerp(db0.y, dbEnd.y, p);
      const qx = qb.x - Math.min(p / drop, 1) * 4;
      player(dx, dy, teams.them, p > 0.92 && !complete ? "up" : legs(t));
      player(wx, wy, teams.mine, p < 1 ? legs(t) : "stand");
      player(qx, qb.y, teams.mine, p < drop ? legs(t) : "stand");
      if (p < drop) {
        ball(qx + 2, qb.y - 6);
      } else {
        const q = (p - drop) / (1 - drop);
        const bx = lerp(qx + 2, complete ? catchAt.x : catchAt.x + 6, ease(q));
        const by = lerp(qb.y - 6, complete ? catchAt.y - 6 : mid + 8, q) - Math.sin(Math.PI * q) * peak;
        r(Math.round(bx) - 1, mid + 12, 3, 1, "#1b4d1a"); // shadow on the grass
        ball(bx, by);
      }
    });
    return { wr: catchAt, db: dbEnd };
  }

  function burst(x, y) {
    for (const [dx, dy] of [[-3, -3], [3, -3], [-3, 3], [3, 3], [0, -4], [0, 4], [-4, 0], [4, 0]]) r(x + dx, y + dy, 1, 1, PALETTE.line);
  }

  async function confettiOnField(ms, draw) {
    if (reduceMotion.matches) return;
    const bits = Array.from({ length: 60 }, () => ({
      x: Math.random() * W, y: -Math.random() * 30, v: 0.4 + Math.random() * 0.8, c: CONFETTI[(Math.random() * CONFETTI.length) | 0],
    }));
    await tween(ms, (p, t) => {
      draw(t);
      for (const b of bits) {
        b.y += b.v;
        b.x += Math.sin((b.y + b.x) / 6) * 0.4;
        if (b.y > 0 && b.y < H) r(Math.round(b.x), Math.round(b.y), 1, 1, b.c);
      }
    });
  }

  /** Animate a play from the old state to the new one. */
  async function animate(event, before, after) {
    const old = { yl: before.yl, toGo: before.toGo };
    call("onSnap");

    if (!event.yards) {
      // Incomplete: the defender gets a hand on it and the ball hits the turf.
      const { wr, db } = await passPlay(old, 0, { peak: 8, ms: 520, complete: false });
      call("onIncomplete");
      const landX = wr.x + 6;
      await tween(320, (p) => {
        scene(old);
        player(db.x, db.y, teams.them, "up");
        player(wr.x, wr.y, teams.mine, "stand");
        player(xOf(old.yl) - 9, mid + 9, teams.mine);
        ball(landX + 6 * p, mid + 8 - Math.abs(Math.sin(Math.PI * 2 * p)) * 4);
      });
      callout(event.timedOut ? "TIME" : "INC", landX, "#f4f4ec");
      await hold(650);
      draw(after);
      return;
    }

    // A completion: deeper throws fly higher, farther and faster.
    const tier = tierOf(event.rarity);
    const toX = event.td ? xOf(105) : xOf(after.yl);
    const { wr, db } = await passPlay(old, toX, {
      peak: { check: 5, seam: 11, bomb: 18 }[tier],
      ms: { check: 520, seam: 620, bomb: 760 }[tier],
      complete: true,
    });
    call("onCatch", tier);
    burst(toX, wr.y - 6);
    if (tier === "bomb") call("onBomb");

    if (event.td) {
      call("onTouchdown");
      await flashEnd(PALETTE.scoreText, "TD");
      // Touchdown dance, with confetti.
      await confettiOnField(1400, (t) => {
        scene({ yl: 99, toGo: 0, showFirst: false });
        player(db.x, db.y, teams.them, "stand");
        const step = Math.floor(t / 140) % 4;
        player(toX, mid + 1, teams.mine, step === 1 ? "jump" : step === 3 ? "up" : "stand");
        if (step !== 1) ball(toX + 3, mid - 12);
      });
      callout("TOUCHDOWN", W / 2, PALETTE.scoreText);
      await hold(900);
      draw(after);
      return;
    }

    scene(old);
    player(db.x, db.y, teams.them, "stand");
    player(wr.x, wr.y, teams.mine, "up");
    ball(wr.x + 2, wr.y - 12);
    callout(`+${event.yards}`, toX, TIER_COLOR[tier], tier === "bomb" ? 3 : 2);
    await hold(tier === "bomb" ? 900 : 650);
    if (event.firstDown) {
      call("onFirstDown");
      const fx = xOf(Math.min(after.yl + after.toGo, 99));
      for (let i = 0; i < 2; i++) {
        draw(after);
        r(fx - 1, top, 3, bottom - top, FIRST);
        callout("1ST DOWN", (xOf(after.yl) + fx) / 2, FIRST, 1);
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
      scene({ yl: 99, toGo: 0, showFirst: false, flash: { x, w: 10 * YARD - 1, color } });
      drawText(r, text, x + Math.round((10 * YARD - text.length * 6) / 2), mid - 3, PALETTE.board, 1);
      await hold(160);
      scene({ yl: 99, toGo: 0, showFirst: false });
      await hold(110);
    }
  }

  /** Your team on the left end zone and jerseys; today's opponent on the right. */
  function setTeams(next) {
    teams = { ...teams, ...next };
    paintBase();
    formation(state);
  }

  function setSpeed(s) {
    speed = s;
  }

  draw({ yl: 25, toGo: 10, phase: "ready" });
  return { draw, animate, setTeams, setSpeed };
}

/** A slightly darker shade for end-zone stripes. */
function shade(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  const f = (v) => Math.max(0, Math.round(v * 0.82)).toString(16).padStart(2, "0");
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
}
