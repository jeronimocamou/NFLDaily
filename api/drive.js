// Signed-in drives. The server keeps the drive state and times every play.
// GET  /api/drive?date=YYYY-MM-DD -> { state, question, event }
// POST /api/drive { date, action: "play" | "fg" | "pat1" | "pat2" | "answer", guess }
import { handler, send } from "../lib/http.js";
import { db, dbEnabled } from "../lib/db.js";
import { currentUser } from "../lib/auth.js";
import { isPlayable, loadPuzzle } from "../lib/puzzles.js";
import { act, getDrive } from "../lib/drives.js";

const ACTIONS = new Set(["play", "fg", "pat1", "pat2", "answer"]);

export default handler(["GET", "POST"], async (req, res) => {
  if (!dbEnabled) return send(res, 503, { error: "Accounts aren't set up yet." });
  const date = req.method === "GET" ? req.query.date : req.body.date;
  if (!isPlayable(date) || !loadPuzzle(date)) return send(res, 404, { error: "No puzzle for that date" });
  const pool = await db();
  const user = await currentUser(pool, req);
  if (!user) return send(res, 401, { error: "Sign in first." });

  if (req.method === "GET") {
    const out = await getDrive(pool, user.id, date);
    return send(res, 200, { state: out.state, question: out.question, event: out.event, onTime: out.onTime, now: Date.now() });
  }
  const { action, guess } = req.body;
  if (!ACTIONS.has(action)) return send(res, 400, { error: "Unknown action" });
  const out = await act(pool, user.id, date, action, guess);
  if (out.error && !out.state) return send(res, 409, { error: out.error });
  send(res, 200, {
    state: out.state, question: out.question ?? null, event: out.event ?? null,
    reveal: out.reveal ?? null, hint: out.hint ?? null, notice: out.error ?? null, now: Date.now(),
  });
});
