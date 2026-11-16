// GET  /api/stats?date=YYYY-MM-DD[&score=RANK] -> how everyone did: per-question
//      % perfect and averages, number of finished drives, TD rate, and the
//      share of other drives that `score` (a driveRank number) beats.
// POST /api/stats { date, log } -> add an anonymous player's finished drive.
//      The server replays the whole drive and re-grades every guess.
import { handler, send } from "../lib/http.js";
import { db, dbEnabled } from "../lib/db.js";
import { currentUser } from "../lib/auth.js";
import { isPlayable } from "../lib/puzzles.js";
import { crowdStats, recordDay } from "../lib/crowd.js";
import { replayDrive } from "../lib/drives.js";
import { driveRank } from "../site/drive.js";

export default handler(["GET", "POST"], async (req, res) => {
  if (!dbEnabled) return send(res, 200, { enabled: false });
  const date = req.method === "GET" ? req.query.date : req.body.date;
  if (!isPlayable(date)) return send(res, 404, { error: "No puzzle for that date" });
  const pool = await db();
  if (req.method === "POST") {
    if (await currentUser(pool, req)) return send(res, 200, { recorded: false }); // signed-in drives record themselves
    const sum = await replayDrive(pool, date, req.body.log);
    if (!sum) return send(res, 400, { error: "That drive doesn't add up." });
    await recordDay(pool, date, driveRank(sum));
    return send(res, 200, { recorded: true, rank: driveRank(sum) });
  }
  const score = req.query.score != null ? Number(req.query.score) : null;
  send(res, 200, { enabled: true, ...(await crowdStats(pool, date, Number.isInteger(score) ? score : null)) });
});
