// GET  /api/account?today=YYYY-MM-DD -> { enabled, user, stats }
// POST /api/account { action: "signup" | "login" | "logout", username, password, games }
import { handler, send } from "../lib/http.js";
import { db, dbEnabled } from "../lib/db.js";
import { DATE_RE, currentWindow } from "../lib/puzzles.js";
import { USERNAME_RE, createSession, currentUser, destroySession, hashPassword, verifyPassword } from "../lib/auth.js";
import { statsFor } from "../lib/results.js";

const MAX_FAILS = 10;

function clientToday(value) {
  const { earliest, latest } = currentWindow();
  return DATE_RE.test(value || "") && value >= earliest && value <= latest ? value : latest;
}

export default handler(["GET", "POST"], async (req, res) => {
  if (!dbEnabled) return send(res, req.method === "GET" ? 200 : 503, { enabled: false, user: null, error: "Accounts aren't set up yet." });
  const pool = await db();

  if (req.method === "GET") {
    const user = await currentUser(pool, req);
    return send(res, 200, {
      enabled: true,
      user: user ? { username: user.username } : null,
      stats: user ? await statsFor(pool, user.id, clientToday(req.query.today)) : null,
    });
  }

  const { action, username = "", password = "" } = req.body;

  if (action === "logout") {
    await destroySession(pool, req, res);
    return send(res, 200, { user: null });
  }

  if (action === "signup") {
    if (!USERNAME_RE.test(username)) return send(res, 400, { error: "Usernames are 3–20 letters, numbers or underscores." });
    if (typeof password !== "string" || password.length < 8 || password.length > 200) {
      return send(res, 400, { error: "Passwords need at least 8 characters." });
    }
    const { rows } = await pool.query(
      `INSERT INTO users (username, username_lower, pass_hash) VALUES ($1, $2, $3)
       ON CONFLICT (username_lower) DO NOTHING RETURNING id, username`,
      [username, username.toLowerCase(), await hashPassword(password)],
    );
    if (!rows[0]) return send(res, 409, { error: "That username is taken." });
    await createSession(pool, req, res, rows[0].id);
    return send(res, 200, { user: { username: rows[0].username } });
  }

  if (action === "login") {
    const { rows } = await pool.query("SELECT * FROM users WHERE username_lower = $1", [String(username).toLowerCase()]);
    const user = rows[0];
    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      return send(res, 429, { error: "Too many tries. Wait 15 minutes and try again." });
    }
    if (!user || typeof password !== "string" || !(await verifyPassword(password, user.pass_hash))) {
      if (user) {
        await pool.query(
          `UPDATE users SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + interval '15 minutes' END
           WHERE id = $1`,
          [user.id, MAX_FAILS],
        );
      }
      return send(res, 401, { error: "Wrong username or password." });
    }
    await pool.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [user.id]);
    await createSession(pool, req, res, user.id);
    return send(res, 200, { user: { username: user.username } });
  }

  send(res, 400, { error: "Unknown action" });
});
