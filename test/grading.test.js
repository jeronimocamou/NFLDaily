// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { grade, isPlayable, publicPuzzle, loadPuzzle, index } from "../lib/puzzles.js";

const files = readdirSync(new URL("../puzzles/", import.meta.url)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
const puzzles = files.map((f) => JSON.parse(readFileSync(new URL(`../puzzles/${f}`, import.meta.url), "utf8")));

test("every puzzle is a drive: 24 plays plus two point-after questions", () => {
  assert.ok(puzzles.length >= 365);
  for (const p of puzzles) {
    assert.equal(p.format, "drive", p.date);
    assert.equal(p.rounds.length, 26, p.date);
    assert.deepEqual(p.rounds.slice(24).map((r) => r.role), ["pat1", "pat2"], p.date);
    assert.ok(p.rounds.slice(0, 24).every((r) => r.role === "play" && r.call), p.date);
    for (const r of p.rounds.slice(24)) assert.ok(["head_to_head", "odd_one_out"].includes(r.type), `${p.date} single-answer PAT`);
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

test("no season points questions, and plenty of all-time questions, from 2026-11-16 on", () => {
  const recent = puzzles.filter((p) => p.date >= "2026-11-16");
  let allTime = 0;
  let total = 0;
  for (const p of recent) {
    for (const r of p.rounds) {
      total++;
      assert.ok(!/points did the .* score|points scored/.test(r.prompt), `${p.date}: ${r.prompt}`);
      if (r.season === "Since 1999") {
        allTime++;
        assert.ok(r.prompt.includes("1999"), `${p.date}: all-time prompts say "since 1999": ${r.prompt}`);
      }
    }
  }
  assert.ok(allTime / total > 0.35, `all-time share ${allTime}/${total}`);
});
