// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { grade, isPlayable, publicPuzzle, loadPuzzle, index } from "../lib/puzzles.js";

const files = readdirSync(new URL("../puzzles/", import.meta.url)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
const puzzles = files.map((f) => JSON.parse(readFileSync(new URL(`../puzzles/${f}`, import.meta.url), "utf8")));

test("every puzzle has 5 valid rounds from 5 different seasons", () => {
  assert.ok(puzzles.length >= 365);
  for (const p of puzzles) {
    assert.equal(p.rounds.length, 5, p.date);
    assert.equal(new Set(p.rounds.map((r) => r.season)).size, 5, p.date);
    for (const r of p.rounds) {
      assert.ok(r.reveal && r.reveal.fact, `${p.date} ${r.type} has a reveal`);
      if (r.type === "guess_number") assert.ok(r.reveal.answer >= r.min && r.reveal.answer <= r.max, `${p.date} answer in range`);
    }
  }
});

test("the correct answer always scores 100", () => {
  for (const p of puzzles) {
    for (const r of p.rounds) {
      assert.equal(grade(r, r.reveal.answer).score, 100, `${p.date} ${r.type}`);
    }
  }
});

test("public puzzles never include answers", () => {
  for (const p of puzzles) assert.ok(!JSON.stringify(publicPuzzle(p)).includes('"reveal"'), p.date);
});

test("partial credit and attempts", () => {
  const p = loadPuzzle(index.launch);
  const num = { type: "guess_number", min: 0, max: 16, scoring: { type: "steps", steps: [100, 60, 30, 10] }, reveal: { answer: 10 } };
  assert.deepEqual([9, 8, 7, 6].map((g) => grade(num, g).score), [60, 30, 10, 0]);
  const lin = { type: "guess_number", min: 0, max: 700, scoring: { type: "linear", exact: 10, zero_at: 110 }, reveal: { answer: 400 } };
  assert.deepEqual([405, 460, 600].map((g) => grade(lin, g).score), [100, 50, 0]);
  const who = p.rounds.find((r) => r.type === "who_am_i");
  const wrong = (who.reveal.answer + 1) % who.options.length;
  assert.equal(grade(who, wrong, 1).done, false);
  assert.ok(grade(who, wrong, 1).hint);
  assert.equal(grade(who, who.reveal.answer, 2).score, 50);
  assert.deepEqual(grade(who, wrong, 2), { valid: true, done: true, score: 0 });
  assert.equal(grade(p.rounds[0], 7).valid, false);
});

test("future puzzles are not playable", () => {
  assert.equal(isPlayable("2099-01-01"), false);
  assert.equal(isPlayable(index.launch), true);
  assert.equal(isPlayable("../etc"), false);
});
