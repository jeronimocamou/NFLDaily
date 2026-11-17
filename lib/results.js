// Stats and leaderboards for signed-in players, from their drives.
import { earnedBadges } from "../site/badges.js";

/** What the client sees for one graded answer. Reveal only once it's done. */
export function roundView(round, row) {
  const view = { done: row.done, score: row.score, attempts: row.attempts, guesses: row.guesses };
  if (row.done) view.reveal = round.reveal;
  else if (row.attempts > 0 && round.reveal.hint) view.hint = round.reveal.hint;
  return view;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function streaks(onTimeDates, today) {
  const onTime = new Set(onTimeDates);
  let streak = 0;
  for (let d = onTime.has(today) ? today : addDays(today, -1); onTime.has(d); d = addDays(d, -1)) streak++;
  let best = 0;
  for (const d of onTime) {
    if (onTime.has(addDays(d, -1))) continue; // only count from the start of each run
    let run = 0;
    for (let x = d; onTime.has(x); x = addDays(x, 1)) run++;
    best = Math.max(best, run);
  }
  return { streak, best };
}

export async function statsFor(pool, userId, today) {
  const { rows } = await pool.query(
    "SELECT date, points, yards, clock, rank, on_time, state->'log' AS log FROM drives WHERE user_id = $1 AND done ORDER BY date",
    [userId],
  );
  // Days finished in the original 5-round format still count as played.
  const legacy = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (SELECT date FROM results WHERE user_id = $1 AND done
       GROUP BY date HAVING COUNT(*) = 5) g`,
    [userId],
  );
  const best = rows.reduce((b, r) => (!b || Number(r.rank) > Number(b.rank) ? r : b), null);
  return {
    played: rows.length + legacy.rows[0].n,
    drives: rows.length,
    tds: rows.filter((r) => r.points >= 6).length,
    avgYards: rows.length ? Math.round(rows.reduce((n, r) => n + r.yards, 0) / rows.length) : 0,
    bestDrive: best ? { points: best.points, yards: best.yards, clock: best.clock, date: best.date } : null,
    ...streaks(rows.filter((r) => r.on_time).map((r) => r.date), today),
    badges: earnedBadges(rows.map((r) => ({ date: r.date, onTime: r.on_time, log: r.log || [] }))),
  };
}

export async function leaderboard(pool, date, userId, leagueId = null) {
  // Optionally limit to one league's members.
  const inLeague = leagueId ? `AND d.user_id IN (SELECT user_id FROM league_members WHERE league_id = ${Number(leagueId)})` : "";
  const daily = await pool.query(
    `SELECT u.username, d.points, d.yards, d.clock, d.user_id,
            RANK() OVER (ORDER BY d.rank DESC)::int AS rank
     FROM drives d JOIN users u ON u.id = d.user_id
     WHERE d.date = $1 AND d.done AND d.on_time ${inLeague}
     ORDER BY d.rank DESC, d.updated_at ASC`,
    [date],
  );
  const allTime = await pool.query(
    `WITH t AS (
       SELECT d.user_id, SUM(d.points)::int AS total, COUNT(*)::int AS games,
              COUNT(*) FILTER (WHERE d.points >= 6)::int AS tds, ROUND(AVG(d.yards))::int AS avg_yards
       FROM drives d WHERE d.done AND d.on_time ${inLeague} GROUP BY d.user_id)
     SELECT u.username, t.total, t.games, t.tds, t.avg_yards, t.user_id,
            RANK() OVER (ORDER BY t.total DESC, t.avg_yards DESC)::int AS rank
     FROM t JOIN users u ON u.id = t.user_id
     ORDER BY t.total DESC, t.avg_yards DESC`,
  );
  const shape = (rows) => {
    const top = rows.slice(0, 50).map(({ user_id, ...r }) => ({ ...r, me: user_id === userId }));
    const mine = rows.find((r) => r.user_id === userId);
    const me = mine ? (({ user_id, ...r }) => ({ ...r, me: true }))(mine) : null;
    return { top, me, count: rows.length };
  };
  return { daily: shape(daily.rows), allTime: shape(allTime.rows) };
}
