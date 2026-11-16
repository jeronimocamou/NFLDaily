// Signed-in drives: the server runs the drive, times every play itself and
// saves the state, so leaderboard results can't be fudged from the browser.
import { isOnTime, loadPuzzle } from "./puzzles.js";
import { gradePlay } from "./plays.js";
import { RULES, driveRank, newDrive, resolve, snap, summary } from "../site/drive.js";
import { recordDay, recordRound } from "./crowd.js";

export const layoutOf = (puzzle) => puzzle.layout;

/** The question for the live play, without its answer. */
export function liveQuestion(puzzle, s) {
  if (s.phase !== "live") return null;
  const { reveal, ...pub } = puzzle.rounds[s.live.round];
  const q = { index: s.live.round, ...pub };
  if (s.live.attempts > 0 && reveal.hint) q.hint = reveal.hint;
  return q;
}

async function load(client, userId, date) {
  const { rows } = await client.query("SELECT state, on_time FROM drives WHERE user_id = $1 AND date = $2 FOR UPDATE", [userId, date]);
  return rows[0] || null;
}

async function save(client, userId, date, s, onTime) {
  const over = s.phase === "over";
  const sum = over ? summary(s) : null;
  await client.query(
    `INSERT INTO drives (user_id, date, state, points, yards, clock, rank, done, on_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, date) DO UPDATE
       SET state = $3, points = $4, yards = $5, clock = $6, rank = $7, done = $8, updated_at = now()`,
    [userId, date, JSON.stringify(s), sum?.points ?? 0, sum?.yards ?? 0, sum?.clock ?? 0, sum ? driveRank(sum) : 0, over, onTime],
  );
}

/** If a play was left hanging past the play clock (tab closed), call delay of game. */
function expire(puzzle, s, now) {
  if (s.phase !== "live") return { state: s, event: null };
  const secs = (now - s.live.servedAt) / 1000;
  if (secs <= RULES.playClock + 2) return { state: s, event: null };
  return resolve(s, puzzle.rounds[s.live.round], null, secs, layoutOf(puzzle));
}

async function withDrive(pool, userId, date, fn) {
  const puzzle = loadPuzzle(date);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await load(client, userId, date);
    const onTime = row ? row.on_time : isOnTime(date);
    // Drives saved before play calls existed restart (finished ones are kept as they are).
    const saved = row && (row.state.used || row.state.phase === "over") ? row.state : null;
    const out = await fn(saved || newDrive(), puzzle, onTime);
    if (out.state) await save(client, userId, date, out.state, onTime);
    await client.query("COMMIT");
    if (out.after) await out.after();
    return { ...out, onTime };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function getDrive(pool, userId, date, now = Date.now()) {
  return withDrive(pool, userId, date, async (s, puzzle) => {
    const { state, event } = expire(puzzle, s, now);
    return { state, event, question: liveQuestion(puzzle, state) };
  });
}

/**
 * Take an action: "run" | "pass" | "deep" | "fg" | "pat1" | "pat2" start a
 * play (the play clock starts now); "answer" answers the live question.
 */
export function act(pool, userId, date, action, guess, now = Date.now()) {
  return withDrive(pool, userId, date, async (s0, puzzle) => {
    const n = layoutOf(puzzle);
    let { state: s, event } = expire(puzzle, s0, now);
    if (event) return { state: s, event, question: null, error: "The play clock ran out." };

    if (action !== "answer") {
      const next = snap(s, action, now, n);
      if (!next) return { state: null, error: "You can't do that right now." };
      return { state: next, question: liveQuestion(puzzle, next) };
    }

    if (s.phase !== "live") return { state: null, error: "There's no play running." };
    const idx = s.live.round;
    const round = puzzle.rounds[idx];
    const secs = (now - s.live.servedAt) / 1000;
    if (guess == null || secs > RULES.playClock) {
      const r = resolve(s, round, null, secs, n);
      return { state: r.state, event: r.event, reveal: publicReveal(round) };
    }
    const g = await gradePlay(pool, date, idx, round, guess, s.live.attempts + 1);
    if (!g.valid) return { state: null, error: "Invalid guess" };
    s.live.attempts += 1;
    s.live.guesses.push(guess);
    if (!g.done) return { state: s, question: liveQuestion(puzzle, s), hint: g.hint };
    const r = resolve(s, round, g.result, secs, n);
    const after = async () => {
      await recordRound(pool, date, idx, g.result.score);
      if (r.state.phase === "over") await recordDay(pool, date, driveRank(summary(r.state)));
    };
    return { state: r.state, event: r.event, reveal: publicReveal(round), popular: g.popular, after };
  });
}

/** What the browser gets once a question is over (no internal weights). */
export function publicReveal(round) {
  const { prior, ...rest } = round.reveal;
  return rest;
}

/**
 * Re-run an anonymous player's drive from its log, re-grading every guess on
 * the server, to add the result to "how everyone did". Returns the summary
 * or null if the log doesn't hold together. (Times come from the browser,
 * which is why these never reach leaderboards.)
 */
export async function replayDrive(pool, date, log) {
  const puzzle = loadPuzzle(date);
  if (!puzzle || !Array.isArray(log) || log.length > 40) return null;
  const layout = layoutOf(puzzle);
  let s = newDrive();
  for (const e of log) {
    if (!e || typeof e !== "object") return null;
    const next = snap(s, e.kind, 0, layout);
    if (!next || next.live.round !== e.round) return null;
    const round = puzzle.rounds[e.round];
    const guesses = Array.isArray(e.guesses) ? e.guesses : [];
    const secs = Number(e.secs);
    if (!Number.isFinite(secs) || secs < 0 || guesses.length > 2) return null;
    let result = null;
    for (const [i, guess] of guesses.entries()) {
      const g = await gradePlay(pool, date, e.round, round, guess, i + 1, { record: false });
      if (!g.valid) return null;
      if (g.done) {
        if (i !== guesses.length - 1) return null;
        result = g.result;
      }
    }
    if (result == null && guesses.length && secs <= RULES.playClock) return null;
    next.live.guesses = guesses;
    s = resolve(next, round, result, result == null ? Math.max(secs, RULES.playClock + 1) : secs, layout).state;
  }
  return s.phase === "over" ? summary(s) : null;
}
