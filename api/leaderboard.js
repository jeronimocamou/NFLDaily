// GET /api/leaderboard?date=YYYY-MM-DD[&league=ID] -> daily + all-time leaderboards.
// Only games played on the day by signed-in players count.
import { handler, send } from "../lib/http.js";
import { db, dbEnabled } from "../lib/db.js";
import { currentUser } from "../lib/auth.js";
import { isPlayable } from "../lib/puzzles.js";
import { leaderboard } from "../lib/results.js";
import { isMember } from "../lib/leagues.js";

export default handler(["GET"], async (req, res) => {
  if (!dbEnabled) return send(res, 200, { enabled: false });
  const { date } = req.query;
  if (!isPlayable(date)) return send(res, 404, { error: "No puzzle for that date" });
  const pool = await db();
  const user = await currentUser(pool, req);
  let league = null;
  if (req.query.league) {
    league = Number(req.query.league);
    if (!user || !Number.isInteger(league) || !(await isMember(pool, league, user.id))) {
      return send(res, 403, { error: "You're not in that league." });
    }
  }
  send(res, 200, { enabled: true, date, league, ...(await leaderboard(pool, date, user?.id, league)) });
});
