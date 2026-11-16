// Puzzle loading and grading. Puzzles live in /puzzles (not publicly served);
// only the public part of each round is ever sent before it's answered.
import { readFileSync, existsSync } from "node:fs";

const DIR = new URL("../puzzles/", import.meta.url);
const cache = new Map();

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const index = JSON.parse(readFileSync(new URL("index.json", DIR), "utf8"));

function isoUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The range of calendar dates that are "today" somewhere on Earth (UTC-12 .. UTC+14). */
export function currentWindow(now = Date.now()) {
  return { earliest: isoUTC(now - 12 * 3600e3), latest: isoUTC(now + 14 * 3600e3) };
}

/** A date can be played once it's today somewhere, and never before launch. */
export function isPlayable(date, now = Date.now()) {
  if (!DATE_RE.test(date || "")) return false;
  return date >= index.launch && date <= currentWindow(now).latest && date <= index.last;
}

/** Played "on the day" (counts for leaderboards and streaks) vs from the archive. */
export function isOnTime(date, now = Date.now()) {
  const { earliest, latest } = currentWindow(now);
  return date >= earliest && date <= latest;
}

export function loadPuzzle(date) {
  if (!DATE_RE.test(date || "")) return null;
  if (cache.has(date)) return cache.get(date);
  const file = new URL(`${date}.json`, DIR);
  if (!existsSync(file)) return null;
  const puzzle = JSON.parse(readFileSync(file, "utf8"));
  cache.set(date, puzzle);
  return puzzle;
}

export function publicPuzzle(puzzle) {
  return {
    date: puzzle.date,
    number: puzzle.number,
    layout: puzzle.layout,
    rounds: puzzle.rounds.map(({ reveal, ...pub }) => pub),
  };
}

/** Every playable date from launch to today (newest first). */
export function archiveDates(now = Date.now()) {
  const out = [];
  const [y, m, d] = index.launch.split("-").map(Number);
  for (let t = Date.UTC(y, m - 1, d); ; t += 86400e3) {
    const date = isoUTC(t);
    if (!isPlayable(date, now)) break;
    out.push({ date, number: out.length + 1 });
  }
  return out.reverse();
}

function scoreNumber(scoring, diff) {
  if (scoring.type === "steps") return scoring.steps[diff] ?? 0;
  if (diff <= scoring.exact) return 100;
  return Math.max(0, Math.round((100 * (scoring.zero_at - diff)) / (scoring.zero_at - scoring.exact)));
}

/**
 * Grade a guess. `attempt` is 1-based and only matters for who_am_i.
 * Returns { valid, done, score, hint? }. Throws nothing; invalid input -> { valid: false }.
 */
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
let namesById = null;
function playerName(id) {
  if (!namesById) {
    try {
      const names = JSON.parse(readFileSync(new URL("../site/names.json", import.meta.url), "utf8"));
      namesById = new Map(names.players.map((p) => [p[0], p[1]]));
    } catch {
      namesById = new Map();
    }
  }
  return namesById.get(id);
}

export function grade(round, guess, attempt = 1) {
  const r = round.reveal;
  switch (round.type) {
    case "head_to_head":
    case "odd_one_out": {
      if (!Number.isInteger(guess) || guess < 0 || guess >= round.options.length) return { valid: false };
      return { valid: true, done: true, score: guess === r.answer ? 100 : 0 };
    }
    case "guess_number": {
      if (typeof guess !== "number" || !Number.isFinite(guess)) return { valid: false };
      const g = Math.min(round.max, Math.max(round.min, Math.round(guess)));
      const diff = Math.abs(g - r.answer);
      // "Way off": more than twice as far as the distance where credit runs out.
      const zero = round.scoring.type === "steps" ? round.scoring.steps.length : round.scoring.zero_at;
      return { valid: true, done: true, score: scoreNumber(round.scoring, diff), far: diff >= 2 * zero };
    }
    case "rank_four": {
      const n = round.options.length;
      if (!Array.isArray(guess) || guess.length !== n || new Set(guess).size !== n ||
          !guess.every((x) => Number.isInteger(x) && x >= 0 && x < n)) return { valid: false };
      const score = guess.reduce((s, opt, i) => s + (opt === r.answer[i] ? 100 / n : 0), 0);
      return { valid: true, done: true, score: Math.round(score) };
    }
    case "name_one": {
      // A guess is an answer id (player id or franchise code) picked from autocomplete.
      if (typeof guess !== "string" || !guess || guess.length > 40) return { valid: false };
      let id = r.valid[guess] ? guess : null;
      if (!id && round.answer_kind === "player") {
        // Same-named players (two "Mike Williams"): accept the name.
        const name = playerName(guess);
        if (name) id = Object.keys(r.valid).find((k) => norm(r.valid[k].name) === norm(name)) || null;
      }
      return { valid: true, done: true, hit: Boolean(id), id: id || guess, score: id ? 100 : 0 };
    }
    case "who_am_i": {
      if (!Number.isInteger(guess) || guess < 0 || guess >= round.options.length) return { valid: false };
      const a = Math.min(Math.max(1, attempt | 0), round.max_attempts);
      if (guess === r.answer) return { valid: true, done: true, score: round.scoring.points[a - 1] ?? 0 };
      if (a < round.max_attempts) return { valid: true, done: false, score: 0, hint: r.hint };
      return { valid: true, done: true, score: 0 };
    }
  }
  return { valid: false };
}
