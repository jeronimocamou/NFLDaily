// "How did everyone else do?" Aggregate counts for every player, signed in
// or not: per-round results and a histogram of finished drives per day
// (stored as driveRank numbers: points, then yards, then time left).
import { loadPuzzle } from "./puzzles.js";

export async function recordRound(pool, date, round, score) {
  await pool.query(
    `INSERT INTO round_stats (date, round, plays, perfect, total_score) VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (date, round) DO UPDATE SET plays = round_stats.plays + 1,
       perfect = round_stats.perfect + $3, total_score = round_stats.total_score + $4`,
    [date, round, score >= 100 ? 1 : 0, score],
  );
}

export async function recordDay(pool, date, total) {
  await pool.query(
    `INSERT INTO day_scores (date, score, players) VALUES ($1, $2, 1)
     ON CONFLICT (date, score) DO UPDATE SET players = day_scores.players + 1`,
    [date, total],
  );
}

export async function crowdStats(pool, date, score) {
  const rounds = loadPuzzle(date).rounds.map(() => null);
  const r = await pool.query("SELECT * FROM round_stats WHERE date = $1", [date]);
  for (const row of r.rows) {
    rounds[row.round] = {
      plays: row.plays,
      perfectPct: Math.round((100 * row.perfect) / row.plays),
      avg: Math.round(Number(row.total_score) / row.plays),
    };
  }
  const d = await pool.query("SELECT score, players FROM day_scores WHERE date = $1", [date]);
  const players = d.rows.reduce((n, row) => n + row.players, 0);
  let beat = null;
  if (Number.isInteger(score)) {
    // Compare against everyone else: leave out one drive with this result (yours), if recorded.
    const below = d.rows.filter((row) => row.score < score).reduce((n, row) => n + row.players, 0);
    const others = d.rows.some((row) => row.score === score) ? players - 1 : players;
    if (others > 0) beat = Math.min(100, Math.round((100 * below) / others));
  }
  const points = (r) => Math.floor(r.score / 1000000);
  const yards = (r) => Math.floor((r.score % 1000000) / 1000) - 100;
  const tds = d.rows.filter((r) => points(r) >= 6).reduce((n, r) => n + r.players, 0);
  return {
    rounds,
    players,
    beat,
    tdPct: players ? Math.round((100 * tds) / players) : null,
    avgYards: players ? Math.round(d.rows.reduce((n, r) => n + yards(r) * r.players, 0) / players) : null,
  };
}
