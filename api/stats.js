// GET /api/stats?date=YYYY-MM-DD[&score=N] -> how everyone did on a puzzle:
// per-round % perfect and average, number of finishers, and the share of
// other players that `score` beats.
import { handler, send } from "../lib/http.js";
import { db, dbEnabled } from "../lib/db.js";
import { isPlayable } from "../lib/puzzles.js";
import { crowdStats } from "../lib/crowd.js";

export default handler(["GET"], async (req, res) => {
  if (!dbEnabled) return send(res, 200, { enabled: false });
  const { date } = req.query;
  if (!isPlayable(date)) return send(res, 404, { error: "No puzzle for that date" });
  const score = req.query.score != null ? Number(req.query.score) : null;
  const pool = await db();
  send(res, 200, { enabled: true, ...(await crowdStats(pool, date, Number.isInteger(score) ? score : null)) });
});
