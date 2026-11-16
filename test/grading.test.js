// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { grade, isPlayable, publicPuzzle, loadPuzzle, index } from "../lib/puzzles.js";

const files = readdirSync(new URL("../puzzles/", import.meta.url)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
const puzzles = files.map((f) => JSON.parse(readFileSync(new URL(`../puzzles/${f}`, import.meta.url), "utf8")));

test("every day is a playbook: runs, passes, deep shots and two point-after questions", () => {
  assert.ok(puzzles.length >= 365);
  for (const p of puzzles) {
    assert.equal(p.format, "playbook", p.date);
    const L = p.layout;
    for (const call of ["run", "pass", "deep"]) {
      const [start, n] = L[call];
      assert.ok(n >= 5, `${p.date} ${call} count`);
      for (const r of p.rounds.slice(start, start + n)) assert.equal(r.role, call, `${p.date} ${call}`);
    }
    for (const r of p.rounds.slice(L.run[0], L.run[0] + L.run[1])) assert.equal(r.type, "guess_number", p.date);
    for (const r of p.rounds.slice(L.pass[0], L.deep[0] + L.deep[1])) {
      assert.equal(r.type, "name_one", p.date);
      const ids = Object.keys(r.reveal.valid);
      assert.equal(ids.length, r.answers, `${p.date} answer count`);
      assert.deepEqual(Object.keys(r.reveal.prior).sort(), ids.sort(), `${p.date} priors for every answer`);
    }
    assert.ok(["head_to_head", "odd_one_out"].includes(p.rounds[L.pat1].type));
    assert.ok(["head_to_head", "odd_one_out"].includes(p.rounds[L.pat2].type));
    for (const r of p.rounds) assert.ok(r.reveal && r.reveal.fact, `${p.date} ${r.type} has a fact`);
  }
});

test("name-one answers are all typeable from the names index", () => {
  const names = JSON.parse(readFileSync(new URL("../site/names.json", import.meta.url), "utf8"));
  const players = new Set(names.players.map((p) => p[0]));
  const teams = new Set(names.teams.map((t) => t[0]));
  for (const p of puzzles) {
    for (const r of p.rounds.filter((x) => x.type === "name_one")) {
      for (const id of Object.keys(r.reveal.valid)) assert.ok((r.answer_kind === "team" ? teams : players).has(id), `${p.date} ${id}`);
    }
  }
});

test("the correct answer always scores 100", () => {
  for (const p of puzzles) {
    for (const r of p.rounds) {
      const right = r.type === "name_one" ? Object.keys(r.reveal.valid)[0] : r.reveal.answer;
      assert.equal(grade(r, right).score, 100, `${p.date} ${r.type}`);
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
  const n1 = p.rounds.find((r) => r.type === "name_one");
  assert.equal(grade(n1, "not-a-player").hit, false);
  assert.equal(grade(n1, 42).valid, false);
  assert.equal(grade(p.rounds[p.layout.pat1], 7).valid, false);
});

test("future puzzles are not playable", () => {
  assert.equal(isPlayable("2099-01-01"), false);
  assert.equal(isPlayable(index.launch), true);
  assert.equal(isPlayable("../etc"), false);
});

test("no season points questions, and plenty of all-time and multi-year questions, from 2026-11-16 on", () => {
  const recent = puzzles.filter((p) => p.date >= "2026-11-16");
  let allTime = 0;
  let total = 0;
  for (const p of recent) {
    for (const r of p.rounds) {
      total++;
      assert.ok(!/points did the .* score|points scored/.test(r.prompt), `${p.date}: ${r.prompt}`);
      if (typeof r.season !== "number") allTime++; // since 1999, or a decade
      if (r.season === "Since 1999") assert.ok(/1999/.test(r.prompt), `${p.date}: all-time prompts say "since 1999": ${r.prompt}`);
    }
  }
  assert.ok(allTime / total > 0.35, `all-time share ${allTime}/${total}`);
});
