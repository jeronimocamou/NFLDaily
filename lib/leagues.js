// Friends leagues: private leaderboards joined with an invite code.
import { randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
export const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
export const MAX_LEAGUES = 25;

function newCode() {
  let code = "";
  for (let i = 0; i < 6; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export async function isMember(pool, leagueId, userId) {
  const { rowCount } = await pool.query("SELECT 1 FROM league_members WHERE league_id = $1 AND user_id = $2", [leagueId, userId]);
  return rowCount > 0;
}

export async function myLeagues(pool, userId) {
  const { rows } = await pool.query(
    `SELECT l.id, l.name, l.code, (l.owner_id = $1) AS owner,
            (SELECT COUNT(*)::int FROM league_members m2 WHERE m2.league_id = l.id) AS members
     FROM leagues l JOIN league_members m ON m.league_id = l.id
     WHERE m.user_id = $1 ORDER BY m.joined_at`,
    [userId],
  );
  return rows;
}

export async function leagueByCode(pool, code) {
  const { rows } = await pool.query(
    `SELECT l.id, l.name, l.code, (SELECT COUNT(*)::int FROM league_members m WHERE m.league_id = l.id) AS members
     FROM leagues l WHERE l.code = $1`,
    [code],
  );
  return rows[0] || null;
}

async function countMine(pool, userId) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM league_members WHERE user_id = $1", [userId]);
  return rows[0].n;
}

export async function createLeague(pool, userId, name) {
  if ((await countMine(pool, userId)) >= MAX_LEAGUES) return { error: `You can be in up to ${MAX_LEAGUES} leagues.` };
  for (let tries = 0; tries < 5; tries++) {
    const { rows } = await pool.query(
      "INSERT INTO leagues (name, code, owner_id) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING RETURNING id, name, code",
      [name, newCode(), userId],
    );
    if (rows[0]) {
      await pool.query("INSERT INTO league_members (league_id, user_id) VALUES ($1, $2)", [rows[0].id, userId]);
      return { league: { ...rows[0], owner: true, members: 1 } };
    }
  }
  throw new Error("Could not create a unique league code");
}

export async function joinLeague(pool, userId, code) {
  const league = await leagueByCode(pool, code);
  if (!league) return { error: "No league with that code." };
  if (await isMember(pool, league.id, userId)) return { league };
  if ((await countMine(pool, userId)) >= MAX_LEAGUES) return { error: `You can be in up to ${MAX_LEAGUES} leagues.` };
  await pool.query("INSERT INTO league_members (league_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [league.id, userId]);
  return { league: { ...league, members: league.members + 1 } };
}

export async function leaveLeague(pool, userId, leagueId) {
  await pool.query("DELETE FROM league_members WHERE league_id = $1 AND user_id = $2", [leagueId, userId]);
  // Hand ownership to the longest-standing member; delete empty leagues.
  const { rows } = await pool.query(
    "SELECT user_id FROM league_members WHERE league_id = $1 ORDER BY joined_at LIMIT 1",
    [leagueId],
  );
  if (!rows[0]) await pool.query("DELETE FROM leagues WHERE id = $1", [leagueId]);
  else await pool.query("UPDATE leagues SET owner_id = $2 WHERE id = $1 AND (owner_id = $3 OR owner_id IS NULL)", [leagueId, rows[0].user_id, userId]);
}
