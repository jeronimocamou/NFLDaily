// Game sounds, synthesized with the Web Audio API (no files to download):
// a referee's whistle on the snap, a "pop" on the catch, a thud on an
// incompletion, a chime on a first down and a crowd roar on bombs and
// touchdowns. Muting is remembered on this device.

const KEY = "nfldaily:mute";
let ctx = null;
let muted = false;
try {
  muted = localStorage.getItem(KEY) === "1";
} catch {
  /* ignore */
}

export const isMuted = () => muted;

export function setMuted(value) {
  muted = value;
  try {
    localStorage.setItem(KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Create the audio context; call from a click so browsers allow sound. */
export function unlock() {
  if (muted) return;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume();
}

function ready() {
  if (muted || !ctx) return false;
  if (ctx.state === "suspended") ctx.resume();
  return true;
}

function noise(seconds) {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

function envelope(node, t0, attack, hold, release, peak) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.setValueAtTime(peak, t0 + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
  node.connect(g);
  g.connect(ctx.destination);
  return g;
}

/** Referee's whistle: a pea whistle's trill. */
export function whistle() {
  if (!ready()) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(2900, t);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 38;
  const depth = ctx.createGain();
  depth.gain.value = 120;
  lfo.connect(depth);
  depth.connect(osc.frequency);
  envelope(osc, t, 0.02, 0.28, 0.08, 0.12);
  osc.start(t);
  lfo.start(t);
  osc.stop(t + 0.45);
  lfo.stop(t + 0.45);
}

/** The catch: a short leather "pop". */
export function pop() {
  if (!ready()) return;
  const t = ctx.currentTime;
  const n = noise(0.08);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1400;
  bp.Q.value = 1.2;
  n.connect(bp);
  envelope(bp, t, 0.002, 0.01, 0.06, 0.5);
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(520, t);
  osc.frequency.exponentialRampToValueAtTime(160, t + 0.09);
  envelope(osc, t, 0.002, 0.01, 0.08, 0.25);
  n.start(t);
  osc.start(t);
  osc.stop(t + 0.12);
}

/** Incomplete: the ball thuds into the turf. */
export function thud() {
  if (!ready()) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(140, t);
  osc.frequency.exponentialRampToValueAtTime(55, t + 0.2);
  envelope(osc, t, 0.005, 0.02, 0.2, 0.35);
  osc.start(t);
  osc.stop(t + 0.3);
}

/** First down: a quick two-note chime. */
export function chime() {
  if (!ready()) return;
  const t = ctx.currentTime;
  [[880, 0], [1320, 0.09]].forEach(([f, d]) => {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = f;
    envelope(osc, t + d, 0.005, 0.05, 0.18, 0.12);
    osc.start(t + d);
    osc.stop(t + d + 0.3);
  });
}

/** The crowd: filtered noise that swells and fades. Bigger for touchdowns. */
export function roar(big = false) {
  if (!ready()) return;
  const t = ctx.currentTime;
  const len = big ? 3 : 1.8;
  const n = noise(len);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(600, t);
  lp.frequency.linearRampToValueAtTime(big ? 1800 : 1300, t + 0.5);
  n.connect(lp);
  envelope(lp, t, 0.45, big ? 1.2 : 0.5, big ? 1.3 : 0.8, big ? 0.32 : 0.22);
  n.start(t);
  n.stop(t + len);
}
