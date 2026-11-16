// GET /api/archive -> every playable puzzle date (newest first) and, for
// signed-in players, their score on each.
import { handler, send } from "../lib/http.js";
import { db } from "../lib/db.js";
import { currentUser } from "../lib/auth.js";
import { archiveDates } from "../lib/puzzles.js";

export default handler(["GET"], async (req, res) => {
  const pool = await db();
  const user = await currentUser(pool, req);
  let mine = null;
  if (user) {
    const { rows } = await pool.query("SELECT date, points, yards, done FROM drives WHERE user_id = $1", [user.id]);
    mine = Object.fromEntries(rows.map((r) => [r.date, { done: r.done, points: r.points, yards: r.yards }]));
  }
  send(res, 200, { dates: archiveDates(), mine });
});
