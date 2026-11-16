// GET /api/puzzle?date=YYYY-MM-DD -> the day's puzzle without answers.
import { handler, send } from "../lib/http.js";
import { isPlayable, isOnTime, loadPuzzle, publicPuzzle } from "../lib/puzzles.js";
import { db } from "../lib/db.js";
import { currentUser } from "../lib/auth.js";

export default handler(["GET"], async (req, res) => {
  const { date } = req.query;
  if (!isPlayable(date)) return send(res, 404, { error: "No puzzle for that date" });
  const puzzle = loadPuzzle(date);
  if (!puzzle) return send(res, 404, { error: "No puzzle for that date" });
  const pool = await db();
  const user = await currentUser(pool, req);
  // Signed-in players get their questions one play at a time from /api/drive.
  const pub = publicPuzzle(puzzle);
  send(res, 200, {
    puzzle: user ? { date: pub.date, number: pub.number, layout: pub.layout } : pub,
    onTime: isOnTime(date),
    user: user ? { username: user.username } : null,
  });
});
