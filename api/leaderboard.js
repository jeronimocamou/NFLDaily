// GET /api/leaderboard?date=YYYY-MM-DD -> daily + all-time leaderboards.
// Only games played on the day by signed-in players count.
import { handler, send } from "../lib/http.js";
import { db, dbEnabled } from "../lib/db.js";
import { currentUser } from "../lib/auth.js";
import { isPlayable } from "../lib/puzzles.js";
import { leaderboard } from "../lib/results.js";

export default handler(["GET"], async (req, res) => {
  if (!dbEnabled) return send(res, 200, { enabled: false });
  const { date } = req.query;
  if (!isPlayable(date)) return send(res, 404, { error: "No puzzle for that date" });
  const pool = await db();
  const user = await currentUser(pool, req);
  send(res, 200, { enabled: true, date, ...(await leaderboard(pool, date, user?.id)) });
});
