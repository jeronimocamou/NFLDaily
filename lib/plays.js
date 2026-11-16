// Grading one play, with rarity for "name one" answers: how often other
// players gave the same answer decides how many yards it's worth.
import { grade } from "./puzzles.js";
import { rarityOf } from "../site/drive.js";

/** { answerId: count } for one question. */
export async function answerCounts(pool, date, idx) {
  if (!pool) return {};
  const { rows } = await pool.query("SELECT answer, n FROM answer_counts WHERE date = $1 AND round = $2", [date, idx]);
  return Object.fromEntries(rows.map((r) => [r.answer, r.n]));
}

export async function recordAnswerCount(pool, date, idx, answer) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO answer_counts (date, round, answer, n) VALUES ($1, $2, $3, 1)
     ON CONFLICT (date, round, answer) DO UPDATE SET n = answer_counts.n + 1`,
    [date, idx, answer],
  );
}

/** Every right answer with how many players gave it (after this answer), most popular first. */
export function popularity(round, counts, yours) {
  const valid = round.reveal.valid;
  const total = Object.keys(valid).reduce((n, k) => n + (counts[k] || 0), 0);
  return {
    total,
    answers: Object.entries(valid)
      .map(([id, v]) => ({ id, name: v.name, note: v.note, n: counts[id] || 0, pct: total ? Math.round((100 * (counts[id] || 0)) / total) : 0, yours: id === yours }))
      .sort((a, b) => b.n - a.n || (round.reveal.prior[b.id] || 0) - (round.reveal.prior[a.id] || 0)),
  };
}

/**
 * Grade a guess for a play. Returns { valid, done, result, hint?, popular? }
 * where result = { score, hit, rarity, far } is what the drive rules need.
 * When `record` is true, a right name-one answer is added to the counts.
 */
export async function gradePlay(pool, date, idx, round, guess, attempt, { record = true } = {}) {
  const g = grade(round, guess, attempt);
  if (!g.valid) return { valid: false };
  if (!g.done) return { valid: true, done: false, hint: g.hint };
  if (round.type !== "name_one") {
    return { valid: true, done: true, result: { score: g.score, far: Boolean(g.far), hit: g.score >= 100, rarity: 0 } };
  }
  const counts = await answerCounts(pool, date, idx);
  const rarity = g.hit ? rarityOf(g.id, round.reveal.prior, counts) : 0;
  if (g.hit && record) {
    await recordAnswerCount(pool, date, idx, g.id);
    counts[g.id] = (counts[g.id] || 0) + 1;
  }
  return {
    valid: true,
    done: true,
    result: { score: g.score, hit: g.hit, rarity, far: false },
    popular: popularity(round, counts, g.hit ? g.id : null),
  };
}
