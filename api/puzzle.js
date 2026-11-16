// GET /api/puzzle?date=YYYY-MM-DD -> today's puzzle without answers, plus the
// signed-in player's progress on it.
import { handler, send } from "../lib/http.js";
import { isPlayable, isOnTime, loadPuzzle, publicPuzzle } from "../lib/puzzles.js";
import { db } from "../lib/db.js";
import { currentUser } from "../lib/auth.js";
import { progressFor } from "../lib/results.js";

export default handler(["GET"], async (req, res) => {
  const { date } = req.query;
  if (!isPlayable(date)) return send(res, 404, { error: "No puzzle for that date" });
  const puzzle = loadPuzzle(date);
  if (!puzzle) return send(res, 404, { error: "No puzzle for that date" });
  const pool = await db();
  const user = await currentUser(pool, req);
  send(res, 200, {
    puzzle: publicPuzzle(puzzle),
    onTime: isOnTime(date),
    user: user ? { username: user.username } : null,
    progress: user ? await progressFor(pool, user.id, date) : null,
  });
});
