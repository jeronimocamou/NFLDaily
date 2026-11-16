import { test } from "node:test";
import assert from "node:assert/strict";
import { newDrive, snap, resolve, summary, driveRank, downText, fieldSpot, canKick, playsLeft, rarityOf, baseYards } from "../site/drive.js";

const L = { run: [0, 10], pass: [10, 8], deep: [18, 6], pat1: 24, pat2: 25 };
const R = (type) => ({ type });
const run = (score, far = false) => ({ score, far, hit: score >= 100, rarity: 0 });
const hit = (rarity) => ({ score: 100, hit: true, rarity });
const miss = { score: 0, hit: false, rarity: 0 };
function play(s, call, result, secs = 10) {
  const live = snap(s, call, 0, L);
  assert.ok(live, `snap ${call} allowed in phase ${s.phase}`);
  return resolve(live, R(call === "run" ? "guess_number" : "name_one"), result, secs, L);
}

test("yards: runs by closeness, passes and deep shots by rarity", () => {
  assert.deepEqual([100, 50, 1, 0].map((s) => baseYards("run", { score: s })), [12, 7, 2, 0]);
  assert.equal(baseYards("run", { score: 0, far: true }), -3);
  assert.deepEqual([0, 0.5, 1].map((r) => baseYards("pass", hit(r))), [4, 11, 18]);
  assert.equal(baseYards("pass", miss), 0);
  assert.deepEqual([0, 1].map((r) => baseYards("deep", hit(r))), [12, 30]);
  assert.equal(baseYards("deep", miss), -6);
});

test("you call the play; each call uses the next question of its kind", () => {
  let s = newDrive();
  let live = snap(s, "pass", 0, L);
  assert.equal(live.live.round, 10);
  s = resolve(live, R("name_one"), hit(0.5), 10, L).state;
  assert.equal(s.yl, 36);
  assert.equal(downText(s), "1st & 10");
  live = snap(s, "pass", 0, L);
  assert.equal(live.live.round, 11, "second pass is the next pass question");
  live = snap(s, "deep", 0, L);
  assert.equal(live.live.round, 18);
  assert.deepEqual(playsLeft(s, L), { run: 10, pass: 7, deep: 6 });
});

test("incompletions stop the clock; sacks and stuffs lose yards; hurry-up adds 2", () => {
  let r = play(newDrive(), "pass", miss, 5);
  assert.equal(r.event.yards, 0);
  assert.equal(r.state.clock, 120 - 8);
  r = play(r.state, "deep", miss);
  assert.equal(r.event.yards, -6);
  assert.equal(downText(r.state), "3rd & 16");
  r = play(r.state, "run", run(0, true));
  assert.equal(r.event.yards, -3);
  const h = play(newDrive(), "run", run(100), 4);
  assert.equal(h.event.yards, 14);
  assert.ok(h.event.hurry);
});

test("4th down decision; out of field goal range means go for it", () => {
  let s = newDrive();
  for (let i = 0; i < 3; i++) s = play(s, "pass", miss, 1).state;
  assert.equal(s.phase, "decide");
  assert.equal(canKick(s), false);
  assert.equal(snap(s, "fg", 0, L), null);
  const r = play(s, "run", run(0));
  assert.equal(r.state.result, "downs");
});

test("calls run out when their questions are used up", () => {
  const s = { ...newDrive(), used: { run: 0, pass: 0, deep: 5 } };
  const r = play(s, "deep", hit(0), 10);
  assert.equal(playsLeft(r.state, L).deep, 0);
  assert.equal(snap(r.state, "deep", 0, L), null);
  assert.ok(snap(r.state, "pass", 0, L));
});

test("delay of game when the play clock runs out", () => {
  const r = resolve(snap(newDrive(), "run", 0, L), R("guess_number"), null, 26, L);
  assert.ok(r.event.delay);
  assert.equal(r.state.yl, 20);
  assert.equal(r.state.used.run, 1);
});

test("touchdown then two-point try; field goal uses a run question", () => {
  let s = newDrive();
  for (let i = 0; i < 3; i++) s = play(s, "deep", hit(1), 2).state; // 32 yds each
  assert.equal(s.phase, "pat_choice");
  const r = resolve(snap(s, "pat2", 0, L), R("odd_one_out"), { score: 100 }, 4, L);
  assert.equal(summary(r.state).points, 8);
  const k = { ...newDrive(), yl: 85, down: 4, phase: "decide" };
  const fg = snap(k, "fg", 0, L);
  assert.equal(fg.live.round, 0);
  assert.equal(resolve(fg, R("guess_number"), run(10), 5, L).state.result, "fg");
});

test("rarity: obvious answers are worth less, rare and unique ones more", () => {
  const prior = { brady: 10, manning: 8, backup: 1 };
  assert.equal(rarityOf("brady", prior), 0);
  assert.ok(rarityOf("backup", prior) > 0.8);
  // Real answers take over: if everyone says the backup, it stops being rare.
  assert.ok(rarityOf("backup", prior, { backup: 200 }) < 0.05);
  assert.equal(rarityOf("only", { only: 1 }), 1);
});

test("ranking: points beat yards, yards beat time", () => {
  const a = driveRank({ points: 3, yards: 50, clock: 0 });
  const b = driveRank({ points: 0, yards: 75, clock: 120 });
  const c = driveRank({ points: 0, yards: 74, clock: 120 });
  assert.ok(a > b && b > c);
  assert.equal(fieldSpot(62), "OPP 38");
});
