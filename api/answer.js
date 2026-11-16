// POST /api/answer { date, round, guess, attempt } -> grading result.
// Signed-in players' answers are saved and locked; anonymous play is stateless.
import { handler, send } from "../lib/http.js";
import { grade, isPlayable, loadPuzzle } from "../lib/puzzles.js";
import { db } from "../lib/db.js";
import { currentUser } from "../lib/auth.js";
import { recordAnswer, roundView } from "../lib/results.js";
import { gradeHistory, recordDay, recordRound } from "../lib/crowd.js";

export default handler(["POST"], async (req, res) => {
  const { date, round: idx, guess, attempt, history } = req.body;
  if (!isPlayable(date)) return send(res, 404, { error: "No puzzle for that date" });
  const puzzle = loadPuzzle(date);
  const round = Number.isInteger(idx) ? puzzle?.rounds[idx] : null;
  if (!round) return send(res, 400, { error: "Unknown round" });

  const pool = await db();
  const user = await currentUser(pool, req);
  if (user) {
    const out = await recordAnswer(pool, user.id, date, idx, guess);
    if (!out.ok) return send(res, 400, { error: "Invalid guess" });
    if (out.newlyDone) await recordRound(pool, date, idx, out.view.score);
    if (out.gameTotal != null) await recordDay(pool, date, out.gameTotal);
    return send(res, 200, out.view);
  }

  const n = Number.isInteger(attempt) ? attempt : 1;
  const g = grade(round, guess, n);
  if (!g.valid) return send(res, 400, { error: "Invalid guess" });
  if (pool && g.done) {
    await recordRound(pool, date, idx, g.score);
    const total = history ? gradeHistory(date, history, idx, g.score) : null;
    if (total != null) await recordDay(pool, date, total);
  }
  send(res, 200, roundView(round, { done: g.done, score: g.score, attempts: n, guesses: [guess] }));
});
