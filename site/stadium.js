// Pixel stadium background: field down the middle, crowds on both sides,
// and the occasional crowd wave.
import { drawField, drawStands } from "./pixel.js";

export function startStadium(canvas) {
  const ctx = canvas.getContext("2d", { alpha: false });
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const r = (x, y, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  let L = null;

  function measure() {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const P = vw >= 900 ? 4 : 3; // CSS pixels per art pixel
    const W = Math.ceil(vw / P);
    const H = Math.ceil(vh / P) + 1;
    const minStand = Math.ceil(24 / P);
    const fieldW = Math.min(W - 2 * minStand, Math.round(640 / P));
    const leftW = Math.floor((W - fieldW) / 2);
    const rightW = W - leftW - fieldW;
    const yard = Math.max(2, Math.floor(fieldW / 56));
    return { P, W, H, fieldW, leftW, rightW, yard };
  }

  function drawStandsOnly(wave = null) {
    drawStands(r, 0, 0, L.leftW, L.H, { side: "left", seed: 7, wave });
    drawStands(r, L.leftW + L.fieldW, 0, L.rightW, L.H, { side: "right", seed: 11, wave });
  }

  function draw() {
    L = measure();
    canvas.width = L.W;
    canvas.height = L.H;
    canvas.style.width = `${L.W * L.P}px`;
    canvas.style.height = `${L.H * L.P}px`;
    drawField(r, L.leftW, 0, L.fieldW, L.H, { vertical: true, yard: L.yard });
    drawStandsOnly();
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 120);
  });
  draw();

  // The wave: sweeps down the stands every so often.
  function wave() {
    if (reduceMotion.matches || document.hidden) return;
    const start = performance.now();
    const duration = 2600;
    let last = 0;
    const step = (t) => {
      const p = (t - start) / duration;
      if (p >= 1) return drawStandsOnly();
      if (t - last > 80) {
        last = t;
        drawStandsOnly(-0.1 + p * 1.2);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  setTimeout(wave, 2500);
  setInterval(wave, 15000);
}
