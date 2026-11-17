// GET /api/recap?date=YYYY-MM-DD -> every right answer (with its tier) for the
// questions in your finished drive. Only after the drive is over, so nobody
// can look up today's answers before playing.
import { handler, send } from "../lib/http.js";
import { db, dbEnabled } from "../lib/db.js";
import { currentUser } from "../lib/auth.js";
import { isPlayable, loadPuzzle } from "../lib/puzzles.js";
import { answerYards } from "../site/drive.js";

export default handler(["GET"], async (req, res) => {
  if (!dbEnabled) return send(res, 503, { error: "Accounts aren't set up yet." });
  const { date } = req.query;
  if (!isPlayable(date)) return send(res, 404, { error: "No puzzle for that date" });
  const pool = await db();
  const user = await currentUser(pool, req);
  if (!user) return send(res, 401, { error: "Sign in first." });
  const { rows } = await pool.query("SELECT state, done FROM drives WHERE user_id = $1 AND date = $2", [user.id, date]);
  if (!rows[0]?.done) return send(res, 403, { error: "Finish the drive first." });
  const puzzle = loadPuzzle(date);
  const recap = {};
  for (const e of rows[0].state.log) {
    const round = puzzle.rounds[e.round];
    if (!round?.reveal?.prior) continue;
    const yours = e.hit ? e.guesses?.[0] : null;
    recap[e.round] = answerYards(round.reveal.valid, round.reveal.prior).map((a) => ({ ...a, yours: a.id === yours }));
  }
  send(res, 200, { recap });
});
