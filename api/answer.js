// POST /api/answer { date, round, guess, attempt } -> grade one answer.
// Used by players who aren't signed in (the browser runs their drive).
// Signed-in players play through /api/drive, which times and saves each play.
import { handler, send } from "../lib/http.js";
import { grade, isPlayable, loadPuzzle } from "../lib/puzzles.js";
import { db } from "../lib/db.js";
import { roundView } from "../lib/results.js";
import { recordRound } from "../lib/crowd.js";

export default handler(["POST"], async (req, res) => {
  const { date, round: idx, guess, attempt } = req.body;
  if (!isPlayable(date)) return send(res, 404, { error: "No puzzle for that date" });
  const puzzle = loadPuzzle(date);
  const round = Number.isInteger(idx) ? puzzle?.rounds[idx] : null;
  if (!round) return send(res, 400, { error: "Unknown round" });

  const n = Number.isInteger(attempt) ? attempt : 1;
  const g = grade(round, guess, n);
  if (!g.valid) return send(res, 400, { error: "Invalid guess" });
  const pool = await db();
  if (pool && g.done) await recordRound(pool, date, idx, g.score);
  send(res, 200, roundView(round, { done: g.done, score: g.score, attempts: n, guesses: [guess] }));
});
