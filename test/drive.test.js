import { test } from "node:test";
import assert from "node:assert/strict";
import { newDrive, snap, resolve, summary, driveRank, downText, fieldSpot, canKick } from "../site/drive.js";

const N = 24;
const R = (type) => ({ type });
function play(s, type, score, secs = 10) {
  const live = snap(s, "play", 0, N);
  assert.ok(live, `snap allowed in phase ${s.phase}`);
  return resolve(live, R(type), score, secs, N);
}

test("a good answer gains yards, moves the chains and runs the clock", () => {
  let { state, event } = play(newDrive(), "odd_one_out", 100);
  assert.equal(event.yards, 12);
  assert.ok(event.firstDown);
  assert.equal(state.yl, 37);
  assert.equal(downText(state), "1st & 10");
  assert.equal(state.clock, 120 - (10 + 3 + 6));
  assert.equal(fieldSpot(state.yl), "OWN 37");
});

test("incompletions stop the clock; sacks lose yards; hurry-up adds 2", () => {
  let r = play(newDrive(), "head_to_head", 0, 5);
  assert.equal(r.event.yards, 0);
  assert.equal(r.state.clock, 120 - 8);
  assert.equal(downText(r.state), "2nd & 10");
  r = play(r.state, "guess_number", 0);
  assert.equal(r.event.yards, -5);
  assert.equal(downText(r.state), "3rd & 15");
  r = play(r.state, "head_to_head", 100, 3);
  assert.equal(r.event.yards, 9);
  assert.ok(r.event.hurry);
});

test("4th down needs a decision; failing turns it over", () => {
  let s = newDrive();
  for (let i = 0; i < 3; i++) s = play(s, "head_to_head", 0, 1).state;
  assert.equal(s.phase, "decide");
  assert.equal(canKick(s), false);
  assert.equal(snap(s, "fg", 0, N), null, "no field goal from your own 25");
  const r = play(s, "head_to_head", 0, 1);
  assert.equal(r.state.phase, "over");
  assert.equal(r.state.result, "downs");
  assert.equal(summary(r.state).points, 0);
});

test("delay of game when the play clock runs out", () => {
  const r = resolve(snap(newDrive(), "play", 0, N), R("rank_four"), null, 26, N);
  assert.ok(r.event.delay);
  assert.equal(r.state.yl, 20);
  assert.equal(downText(r.state), "1st & 15");
  assert.equal(r.state.next, 1, "the question is used up");
});

test("touchdown, then a two-point try", () => {
  let s = newDrive();
  for (let i = 0; i < 3; i++) s = play(s, "who_am_i", 100, 2).state; // 32 yds each with hurry-up
  assert.equal(s.phase, "pat_choice");
  assert.equal(s.points, 6);
  const live = snap(s, "pat2", 0, N);
  assert.equal(live.live.round, N + 1);
  const r = resolve(live, R("odd_one_out"), 100, 4, N);
  assert.equal(r.state.points, 8);
  const sum = summary(r.state);
  assert.deepEqual([sum.label, sum.yards, sum.won], ["TOUCHDOWN", 75, true]);
});

test("field goals depend on distance", () => {
  let s = newDrive();
  s.yl = 70; s.down = 4; s.toGo = 8; s.phase = "decide";
  const long = resolve(snap(s, "fg", 0, N), R("guess_number"), 30, 5, N); // 47 yds needs a perfect answer
  assert.equal(long.state.result, "fg_miss");
  const short = resolve(snap({ ...s, yl: 85 }, "fg", 0, N), R("guess_number"), 10, 5, N); // 32 yds: any credit
  assert.equal(short.state.result, "fg");
  assert.equal(summary(short.state).points, 3);
});

test("time running out ends the drive", () => {
  let s = { ...newDrive(), clock: 10 };
  const r = play(s, "odd_one_out", 100, 9);
  assert.equal(r.state.result, "clock");
  assert.equal(r.state.clock, 0);
});

test("ranking: points beat yards, yards beat time", () => {
  const a = driveRank({ points: 3, yards: 50, clock: 0 });
  const b = driveRank({ points: 0, yards: 75, clock: 120 });
  const c = driveRank({ points: 0, yards: 74, clock: 120 });
  const d = driveRank({ points: 0, yards: -10, clock: 0 });
  assert.ok(a > b && b > c && c > d);
});
