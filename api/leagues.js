// GET  /api/leagues            -> the signed-in player's leagues
// GET  /api/leagues?code=ABC234 -> a league's name (for invite links)
// POST /api/leagues { action: "create", name } | { action: "join", code } | { action: "leave", id }
import { handler, send } from "../lib/http.js";
import { db, dbEnabled } from "../lib/db.js";
import { currentUser } from "../lib/auth.js";
import { CODE_RE, createLeague, joinLeague, leagueByCode, leaveLeague, myLeagues } from "../lib/leagues.js";

export default handler(["GET", "POST"], async (req, res) => {
  if (!dbEnabled) return send(res, 503, { error: "Leagues aren't set up yet." });
  const pool = await db();

  if (req.method === "GET" && req.query.code) {
    const code = String(req.query.code).toUpperCase();
    const league = CODE_RE.test(code) ? await leagueByCode(pool, code) : null;
    if (!league) return send(res, 404, { error: "No league with that code." });
    return send(res, 200, { league: { name: league.name, code: league.code, members: league.members } });
  }

  const user = await currentUser(pool, req);
  if (!user) return send(res, 401, { error: "Sign in to use leagues." });

  if (req.method === "GET") return send(res, 200, { leagues: await myLeagues(pool, user.id) });

  const { action } = req.body;
  if (action === "create") {
    const name = String(req.body.name || "").trim().replace(/\s+/g, " ");
    if (name.length < 3 || name.length > 30) return send(res, 400, { error: "League names are 3–30 characters." });
    const out = await createLeague(pool, user.id, name);
    return out.error ? send(res, 400, out) : send(res, 200, out);
  }
  if (action === "join") {
    const code = String(req.body.code || "").trim().toUpperCase();
    if (!CODE_RE.test(code)) return send(res, 400, { error: "Invite codes are 6 letters and numbers." });
    const out = await joinLeague(pool, user.id, code);
    return out.error ? send(res, 404, out) : send(res, 200, out);
  }
  if (action === "leave") {
    const id = Number(req.body.id);
    if (!Number.isInteger(id)) return send(res, 400, { error: "Unknown league" });
    await leaveLeague(pool, user.id, id);
    return send(res, 200, { ok: true });
  }
  send(res, 400, { error: "Unknown action" });
});
