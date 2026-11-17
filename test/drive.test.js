import { test } from "node:test";
import assert from "node:assert/strict";
import { newDrive, snap, resolve, summary, driveRank, downText, fieldSpot, gainFor, rarityOf, isCurrent } from "../site/drive.js";

const N = 16;
const Q = { type: "name_one" };
const hit = (rarity) => ({ hit: true, rarity });
const miss = { hit: false, rarity: 0 };
function play(s, result, secs = 10) {
  const live = snap(s, 0, N);
  assert.ok(live, `snap allowed in phase ${s.phase}`);
  return resolve(live, Q, result, secs, N);
}

test("right answers gain 5-20 yards by rarity; wrong answers are incomplete", () => {
  assert.deepEqual([0, 0.5, 1].map((r) => gainFor(hit(r))), [5, 13, 20]);
  assert.equal(gainFor(miss), 0);
});

test("questions come in order and move the chains", () => {
  let s = newDrive();
  assert.ok(isCurrent(s));
  const live = snap(s, 0, N);
  assert.equal(live.live.round, 0);
  s = resolve(live, Q, hit(1), 5, N).state;
  assert.equal(s.yl, 45);
  assert.equal(downText(s), "1st & 10");
  assert.equal(snap(s, 0, N).live.round, 1);
  s = play(s, hit(0)).state;
  assert.equal(downText(s), "2nd & 5");
  assert.equal(fieldSpot(s.yl), "50");
});

test("four misses is a turnover on downs; running out of time is incomplete", () => {
  let s = newDrive();
  let r = resolve(snap(s, 0, N), Q, null, 31, N);
  assert.ok(r.event.timedOut);
  assert.equal(r.event.yards, 0);
  s = r.state;
  for (let i = 0; i < 3; i++) s = play(s, miss).state;
  assert.equal(s.phase, "over");
  assert.equal(s.result, "downs");
  const sum = summary(s);
  assert.deepEqual([sum.points, sum.yards, sum.plays, sum.label], [0, 0, 4, "NO SCORE"]);
});

test("touchdown wins with an automatic extra point", () => {
  let s = newDrive();
  for (let i = 0; i < 4; i++) s = play(s, hit(1)).state; // 20 yds each
  assert.equal(s.phase, "over");
  assert.equal(s.result, "td");
  const sum = summary(s);
  assert.deepEqual([sum.points, sum.yards, sum.plays, sum.won], [7, 75, 4, true]);
  assert.equal(sum.codes, "gggt");
});

test("running out of questions ends the drive", () => {
  let s = { ...newDrive(), next: N - 1 };
  s = play(s, hit(0)).state;
  assert.equal(s.phase, "over");
  assert.equal(s.result, "out");
});

test("rarity: obvious answers are worth less, rare and unique ones more", () => {
  const prior = { brady: 10, manning: 8, backup: 1 };
  assert.equal(rarityOf("brady", prior), 0);
  assert.ok(rarityOf("backup", prior) > 0.8);
  assert.ok(rarityOf("backup", prior, { backup: 200 }) < 0.05);
  assert.equal(rarityOf("only", { only: 1 }), 1);
});

test("ranking: points, then yards, then fewer plays", () => {
  const td9 = driveRank({ points: 7, yards: 75, plays: 9 });
  const td5 = driveRank({ points: 7, yards: 75, plays: 5 });
  const long = driveRank({ points: 0, yards: 70, plays: 12 });
  const short = driveRank({ points: 0, yards: 40, plays: 4 });
  assert.ok(td5 > td9 && td9 > long && long > short);
});
