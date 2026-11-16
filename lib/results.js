// Saving answers for signed-in players, plus stats and leaderboards.
import { grade, isOnTime, isPlayable, loadPuzzle } from "./puzzles.js";

/** What the client sees for one round's state. Reveal only once it's done. */
export function roundView(round, row) {
  const view = { done: row.done, score: row.score, attempts: row.attempts, guesses: row.guesses };
  if (row.done) view.reveal = round.reveal;
  else if (row.attempts > 0 && round.reveal.hint) view.hint = round.reveal.hint;
  return view;
}

/** Record a signed-in player's guess. The first final answer is locked in. */
export async function recordAnswer(pool, userId, date, idx, guess) {
  const round = loadPuzzle(date).rounds[idx];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM results WHERE user_id = $1 AND date = $2 AND round = $3 FOR UPDATE",
      [userId, date, idx],
    );
    let row = rows[0];
    if (row?.done) {
      await client.query("COMMIT");
      return { ok: true, view: roundView(round, row) };
    }
    const attempts = (row?.attempts || 0) + 1;
    const g = grade(round, guess, attempts);
    if (!g.valid) {
      await client.query("ROLLBACK");
      return { ok: false };
    }
    const guesses = [...(row?.guesses || []), guess];
    const res = await client.query(
      `INSERT INTO results (user_id, date, round, guesses, attempts, score, done, on_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, date, round) DO UPDATE
         SET guesses = $4, attempts = $5, score = $6, done = $7, updated_at = now()
       RETURNING *`,
      [userId, date, idx, JSON.stringify(guesses), attempts, g.score, g.done, row ? row.on_time : isOnTime(date)],
    );
    await client.query("COMMIT");
    return { ok: true, view: roundView(round, res.rows[0]) };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function progressFor(pool, userId, date) {
  const puzzle = loadPuzzle(date);
  const { rows } = await pool.query("SELECT * FROM results WHERE user_id = $1 AND date = $2", [userId, date]);
  const out = puzzle.rounds.map(() => null);
  for (const row of rows) out[row.round] = roundView(puzzle.rounds[row.round], row);
  return out;
}

/**
 * Import games played before signing in (from the browser). Guesses are
 * re-graded on the server. Imported games never count for leaderboards.
 * games: { "YYYY-MM-DD": { rounds: [{ guesses: [...] }, ...] } }
 */
export async function importGames(pool, userId, games) {
  if (!games || typeof games !== "object") return 0;
  let imported = 0;
  for (const [date, game] of Object.entries(games).slice(0, 400)) {
    if (!isPlayable(date)) continue;
    const puzzle = loadPuzzle(date);
    if (!puzzle || !Array.isArray(game?.rounds)) continue;
    for (const [idx, r] of game.rounds.entries()) {
      const round = puzzle.rounds[idx];
      if (!round || !Array.isArray(r?.guesses) || !r.guesses.length) continue;
      let final = null;
      const used = [];
      for (const [i, guess] of r.guesses.slice(0, round.max_attempts || 1).entries()) {
        const g = grade(round, guess, i + 1);
        if (!g.valid) break;
        used.push(guess);
        final = { ...g, attempts: i + 1 };
        if (g.done) break;
      }
      if (!final) continue;
      const res = await pool.query(
        `INSERT INTO results (user_id, date, round, guesses, attempts, score, done, on_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false) ON CONFLICT DO NOTHING`,
        [userId, date, idx, JSON.stringify(used), final.attempts, final.score, final.done],
      );
      imported += res.rowCount;
    }
  }
  return imported;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function statsFor(pool, userId, today) {
  const { rows } = await pool.query(
    `SELECT date, SUM(score)::int AS total, bool_and(on_time) AS on_time
     FROM results WHERE user_id = $1 AND done
     GROUP BY date HAVING COUNT(*) = 5 ORDER BY date`,
    [userId],
  );
  const totals = rows.map((r) => r.total);
  const onTime = new Set(rows.filter((r) => r.on_time).map((r) => r.date));
  let streak = 0;
  for (let d = onTime.has(today) ? today : addDays(today, -1); onTime.has(d); d = addDays(d, -1)) streak++;
  let best = 0;
  for (const d of onTime) {
    if (onTime.has(addDays(d, -1))) continue; // only count from the start of each run
    let run = 0;
    for (let x = d; onTime.has(x); x = addDays(x, 1)) run++;
    best = Math.max(best, run);
  }
  return {
    played: rows.length,
    avg: totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0,
    high: totals.length ? Math.max(...totals) : 0,
    streak,
    best,
    games: Object.fromEntries(rows.map((r) => [r.date, r.total])),
  };
}

export async function leaderboard(pool, date, userId) {
  const daily = await pool.query(
    `WITH g AS (
       SELECT user_id, SUM(score)::int AS total, MAX(updated_at) AS finished
       FROM results WHERE date = $1 AND done
       GROUP BY user_id HAVING COUNT(*) = 5 AND bool_and(on_time))
     SELECT u.username, g.total, g.user_id,
            RANK() OVER (ORDER BY g.total DESC)::int AS rank
     FROM g JOIN users u ON u.id = g.user_id
     ORDER BY g.total DESC, g.finished ASC`,
    [date],
  );
  const allTime = await pool.query(
    `WITH g AS (
       SELECT user_id, date, SUM(score)::int AS total
       FROM results WHERE done AND on_time
       GROUP BY user_id, date HAVING COUNT(*) = 5),
     t AS (
       SELECT user_id, SUM(total)::int AS total, COUNT(*)::int AS games, ROUND(AVG(total))::int AS avg
       FROM g GROUP BY user_id)
     SELECT u.username, t.total, t.games, t.avg, t.user_id,
            RANK() OVER (ORDER BY t.total DESC)::int AS rank
     FROM t JOIN users u ON u.id = t.user_id
     ORDER BY t.total DESC, t.avg DESC`,
  );
  const shape = (rows) => {
    const top = rows.slice(0, 50).map(({ user_id, ...r }) => ({ ...r, me: user_id === userId }));
    const mine = rows.find((r) => r.user_id === userId);
    const me = mine ? (({ user_id, ...r }) => ({ ...r, me: true }))(mine) : null;
    return { top, me, count: rows.length };
  };
  return { daily: shape(daily.rows), allTime: shape(allTime.rows) };
}
