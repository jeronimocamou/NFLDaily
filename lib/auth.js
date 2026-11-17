// Accounts: username + password (scrypt), sessions in an httpOnly cookie.
import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt);
const COOKIE = "nfld_session";
const SESSION_DAYS = 365;

export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [, salt, key] = stored.split("$");
  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // A malformed cookie from some other app on the domain: ignore it.
    }
  }
  return out;
}

function cookieAttrs(req) {
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export async function createSession(pool, req, res, userId) {
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [sha256(token), userId],
  );
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Max-Age=${SESSION_DAYS * 86400}; ${cookieAttrs(req)}`);
}

export async function destroySession(pool, req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  res.setHeader("Set-Cookie", `${COOKIE}=; Max-Age=0; ${cookieAttrs(req)}`);
}

/** Returns { id, username } for the signed-in user, or null. */
export async function currentUser(pool, req) {
  if (!pool) return null;
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] || null;
}
