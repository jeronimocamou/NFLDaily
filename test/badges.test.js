// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { BADGES, driveFacts, earnedBadges } from "../site/badges.js";

// Log entries as the engine writes them: yards gained (0 = incomplete), code, rarity.
const play = (yards, rarity = 0.1, code) => ({ hit: yards > 0, rarity, yards, code: code || (yards ? "g" : "w") });
const BOMB = 0.9;

test("drive facts: touchdowns, bombs, 4th downs and comebacks", () => {
  // 25 -> 65 (bomb) -> inc, inc, inc -> 4th & 10 converted with 10 -> 75 -> 25 more for the TD.
  const log = [play(40, BOMB), play(0), play(0), play(0), play(10), play(25, 0.5, "t")];
  const f = driveFacts(log);
  assert.equal(f.td, true);
  assert.equal(f.bombs, 1);
  assert.equal(f.incompletions, 3);
  assert.equal(f.fourthDown, true);
  assert.equal(f.comeback, true);
});

test("no comeback badge without a touchdown, and 4 misses end it", () => {
  const f = driveFacts([play(0), play(0), play(0), play(0)]);
  assert.equal(f.td, false);
  assert.equal(f.comeback, false);
  assert.equal(f.fourthDown, false);
});

test("badges are earned once, on the first qualifying day", () => {
  const td = [play(40, BOMB), play(35, BOMB, "t")];
  const drives = [
    { date: "2026-11-17", onTime: true, log: [play(0), play(0), play(0), play(0)] },
    { date: "2026-11-18", onTime: true, log: td },
    { date: "2026-11-19", onTime: true, log: td },
  ];
  const got = earnedBadges(drives);
  assert.equal(got["first-td"], "2026-11-18");
  assert.equal(got["quick-td"], "2026-11-18");
  assert.equal(got["clean-td"], "2026-11-18");
  assert.equal(got["bomb"], "2026-11-18");
  assert.equal(got["streak-3"], "2026-11-19");
  assert.equal(got["three-bombs"], undefined);
  for (const id of Object.keys(got)) assert.ok(BADGES.some((b) => b.id === id), id);
});

test("streak badges need consecutive on-time days", () => {
  const d = (date, onTime = true) => ({ date, onTime, log: [play(0), play(0), play(0), play(0)] });
  assert.equal(earnedBadges([d("2026-11-17"), d("2026-11-18"), d("2026-11-20")])["streak-3"], undefined);
  assert.equal(earnedBadges([d("2026-11-17"), d("2026-11-18", false), d("2026-11-19")])["streak-3"], undefined);
  assert.equal(earnedBadges([d("2026-11-17"), d("2026-11-18"), d("2026-11-19")])["streak-3"], "2026-11-19");
});
