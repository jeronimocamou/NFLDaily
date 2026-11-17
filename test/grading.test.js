// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { grade, isPlayable, publicPuzzle, loadPuzzle, index } from "../lib/puzzles.js";

const files = readdirSync(new URL("../puzzles/", import.meta.url)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
const puzzles = files.map((f) => JSON.parse(readFileSync(new URL(`../puzzles/${f}`, import.meta.url), "utf8")));

test("every day is a drive of broad, typed questions", () => {
  assert.ok(puzzles.length >= 365);
  for (const p of puzzles) {
    assert.equal(p.format, "drive3", p.date);
    assert.ok(p.rounds.length >= 10, p.date);
    for (const r of p.rounds) {
      assert.equal(r.type, "name_one", p.date);
      assert.ok(typeof r.season !== "number", `${p.date}: no single-season questions: ${r.prompt}`);
      const ids = Object.keys(r.reveal.valid);
      assert.ok(ids.length >= 8, `${p.date}: enough right answers (${ids.length}): ${r.prompt}`);
      assert.equal(ids.length, r.answers, p.date);
      assert.deepEqual(Object.keys(r.reveal.prior).sort(), ids.sort(), `${p.date} priors for every answer`);
      assert.ok(r.reveal.fact, `${p.date} has a fact`);
    }
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

test("public puzzles never include answers", () => {
  for (const p of puzzles) assert.ok(!JSON.stringify(publicPuzzle(p)).includes('"reveal"'), p.date);
});

test("grading typed answers", () => {
  const p = loadPuzzle(index.launch);
  const q = p.rounds[0];
  const right = Object.keys(q.reveal.valid)[0];
  assert.equal(grade(q, right).hit, true);
  assert.equal(grade(q, "not-a-player").hit, false);
  assert.equal(grade(q, 42).valid, false);
});

test("future puzzles are not playable", () => {
  assert.equal(isPlayable("2099-01-01"), false);
  assert.equal(isPlayable(index.launch), true);
  assert.equal(isPlayable("../etc"), false);
});


test("drives open with an easy question", () => {
  // Days from 2026-11-19 on (earlier ones were already live when this rule arrived).
  for (const p of puzzles.filter((x) => x.date >= "2026-11-19")) {
    const [first, second] = p.rounds;
    assert.ok(!first.prompt.includes("played for both"), `${p.date}: opener ${first.prompt}`);
    assert.ok(!second.prompt.includes("played for both"), `${p.date}: play 2 ${second.prompt}`);
    const leagueWide = first.answer_kind === "team" || !/ for the | led the /.test(first.prompt);
    assert.ok(leagueWide || first.prompt.startsWith("Name a QB who started a game for"), `${p.date}: opener ${first.prompt}`);
  }
});
