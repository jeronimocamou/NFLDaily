import { test } from "node:test";
import assert from "node:assert/strict";
import { newDrive, snap, resolve, summary, driveRank, downText, fieldSpot, gainFor, rarityOf, answerYards, isCurrent, tierFor, tierCounts } from "../site/drive.js";

const N = 16;
const Q = { type: "name_one" };
const hit = (rarity) => ({ hit: true, rarity });
const miss = { hit: false, rarity: 0 };
function play(s, result, secs = 10) {
  const live = snap(s, 0, N);
  assert.ok(live, `snap allowed in phase ${s.phase}`);
  return resolve(live, Q, result, secs, N);
}

test("three tiers: check-down 10, seam route 20, bomb 40; wrong is incomplete", () => {
  assert.deepEqual([0, 0.39, 0.4, 0.74, 0.75, 1].map((r) => gainFor(hit(r))), [10, 10, 20, 20, 40, 40]);
  assert.deepEqual([0, 0.5, 1].map((r) => tierFor(r).name), ["Check Down", "Seam Route", "Bomb"]);
  assert.equal(gainFor(miss), 0);
  // 10 answers split 4 / 3 / 3
  const prior = Object.fromEntries([...Array(10)].map((_, k) => [`p${k}`, 10 - k]));
  assert.deepEqual(tierCounts(prior), { check: 4, seam: 3, bomb: 3 });
});

test("questions come in order and move the chains", () => {
  let s = newDrive();
  assert.ok(isCurrent(s));
  const live = snap(s, 0, N);
  assert.equal(live.live.round, 0);
  s = resolve(live, Q, hit(0.5), 5, N).state; // seam route
  assert.equal(s.yl, 45);
  assert.equal(downText(s), "1st & 10");
  assert.equal(snap(s, 0, N).live.round, 1);
  s = play(s, hit(0)).state; // check-down: always a first down
  assert.equal(downText(s), "1st & 10");
  assert.equal(fieldSpot(s.yl), "OPP 45");
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
  s = play(s, hit(1)).state; // bomb: 40
  s = play(s, hit(0)).state; // check-down: 10
  s = play(s, hit(1)).state; // bomb: touchdown
  assert.equal(s.phase, "over");
  assert.equal(s.result, "td");
  const sum = summary(s);
  assert.deepEqual([sum.points, sum.yards, sum.plays, sum.won], [7, 75, 3, true]);
  assert.equal(sum.codes, "bmt");
});

test("running out of questions ends the drive", () => {
  let s = { ...newDrive(), next: N - 1 };
  s = play(s, hit(0)).state;
  assert.equal(s.phase, "over");
  assert.equal(s.result, "out");
});

test("rarity comes from our stats: answers ranked by obviousness", () => {
  const prior = { brady: 10, manning: 8, backup: 1, other: 1 };
  assert.equal(rarityOf("brady", prior), 0);
  assert.equal(rarityOf("manning", prior), 1 / 3);
  assert.equal(rarityOf("backup", prior), 2 / 3, "ties share a rank");
  assert.equal(rarityOf("only", { only: 1 }), 1);
  const ys = answerYards({ brady: { name: "Brady" }, backup: { name: "Backup" } }, { brady: 10, backup: 1 });
  assert.deepEqual(ys.map((a) => [a.name, a.yards, a.tier]), [["Backup", 40, "bomb"], ["Brady", 10, "check"]]);
});

test("ranking: points, then yards, then fewer plays", () => {
  const td9 = driveRank({ points: 7, yards: 75, plays: 9 });
  const td5 = driveRank({ points: 7, yards: 75, plays: 5 });
  const long = driveRank({ points: 0, yards: 70, plays: 12 });
  const short = driveRank({ points: 0, yards: 40, plays: 4 });
  assert.ok(td5 > td9 && td9 > long && long > short);
});
