// POST /api/answer { date, round, guess, attempt } -> grade one answer.
// Used by players who aren't signed in (the browser runs their drive).
// Signed-in players play through /api/drive, which times and saves each play.
import { handler, send } from "../lib/http.js";
import { isPlayable, loadPuzzle } from "../lib/puzzles.js";
import { db } from "../lib/db.js";
import { recordRound } from "../lib/crowd.js";
import { gradePlay } from "../lib/plays.js";
import { publicReveal } from "../lib/drives.js";

export default handler(["POST"], async (req, res) => {
  const { date, round: idx, guess } = req.body;
  if (!isPlayable(date)) return send(res, 404, { error: "No puzzle for that date" });
  const puzzle = loadPuzzle(date);
  const round = Number.isInteger(idx) ? puzzle?.rounds[idx] : null;
  if (!round) return send(res, 400, { error: "Unknown round" });

  const pool = await db();
  const g = await gradePlay(pool, date, idx, round, guess);
  if (!g.valid) return send(res, 400, { error: "Invalid guess" });
  if (!g.done) return send(res, 200, { done: false, hint: g.hint });
  if (pool) await recordRound(pool, date, idx, g.result.score);
  send(res, 200, { done: true, result: g.result, reveal: publicReveal(round), answers: g.answers });
});
