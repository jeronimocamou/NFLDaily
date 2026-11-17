// The rules of a drive. Pure functions with no browser or server APIs, so the
// browser (anonymous play, animations) and the server (signed-in play, the
// source of truth for leaderboards) always agree.
//
// You're down 21-17 with the ball on your own 25. Every play is one question:
// type a right answer to gain yards: a check-down (7), seam route (20) or bomb (40),
// depending on how deep a cut the answer is.
// A wrong answer, or running out the 30-second timer, is an incomplete pass.
// You have 4 downs to gain 10 yards. Reach the end zone to win (touchdown +
// automatic extra point = 7 points).

export const RULES = {
  start: 25, // own 25 (touchback)
  playClock: 30, // seconds to answer each question
  them: 21,
  us: 17,
};

export const VERSION = 3; // drives saved by older rule sets restart

/**
 * Every right answer falls in one of three tiers, by how deep a cut it is
 * within its question (see rarityOf): the most obvious ~40% are check-downs,
 * the next ~35% seam routes, and the deepest ~25% (or a question's only
 * answer) bombs.
 */
export const TIERS = [
  { key: "check", name: "Check Down", yards: 7, code: "m", upTo: 0.4 },
  { key: "seam", name: "Seam Route", yards: 20, code: "g", upTo: 0.75 },
  { key: "bomb", name: "Bomb", yards: 40, code: "b", upTo: 1 },
];

export function tierFor(rarity) {
  return TIERS.find((t) => (rarity ?? 0) < t.upTo) || TIERS[TIERS.length - 1];
}

/** Yards for a graded answer: { hit, rarity 0-1 }. */
export function gainFor(result) {
  return result?.hit ? tierFor(result.rarity).yards : 0;
}

export function newDrive() {
  return {
    v: VERSION,
    yl: RULES.start, // yards from your own goal line (100 = touchdown)
    down: 1,
    toGo: 10,
    next: 0, // index of the next question
    phase: "ready", // ready | live | over
    live: null, // { round, servedAt, guesses }
    points: 0,
    result: null, // td | downs | out
    log: [],
  };
}

const clone = (s) => JSON.parse(JSON.stringify(s));
export const isCurrent = (s) => s?.v === VERSION;

/** Start the next play. Returns the new state, or null if not allowed now. */
export function snap(state, now, nPlays) {
  if (state.phase !== "ready" || state.next >= nPlays) return null;
  const s = clone(state);
  s.phase = "live";
  s.live = { round: s.next, servedAt: now, guesses: [] };
  return s;
}

/**
 * Resolve the live play. Push the final guess onto state.live.guesses first.
 * `result` is the graded answer ({ hit, rarity }) or null if time ran out.
 * Returns { state, event } where event describes what happened, for animation.
 */
export function resolve(state, round, result, secs, nPlays) {
  const s = clone(state);
  const live = s.live;
  const timedOut = result == null || secs > RULES.playClock + 1;
  const from = s.yl;
  const yards = timedOut ? 0 : gainFor(result);
  const ev = {
    from, yards: 0, firstDown: false, timedOut,
    hit: !timedOut && !!result.hit, rarity: timedOut ? 0 : result.rarity ?? 0, score: !timedOut && result.hit ? 100 : 0,
  };
  s.live = null;
  s.next += 1;
  s.yl = Math.min(100, s.yl + yards);
  ev.yards = s.yl - from;

  let code;
  if (s.yl >= 100) {
    s.points = 7;
    s.phase = "over";
    s.result = "td";
    ev.td = true;
    ev.text = "TOUCHDOWN!";
    code = "t";
  } else {
    if (timedOut) ev.text = "Time's up. Incomplete.";
    else if (!ev.yards) ev.text = "Incomplete pass.";
    else ev.text = `${tierFor(ev.rarity).name}! ${ev.yards} yards.`;
    if (ev.yards >= s.toGo) {
      s.down = 1;
      s.toGo = Math.min(10, 100 - s.yl);
      ev.firstDown = true;
      ev.text += " First down!";
    } else {
      s.down += 1;
      s.toGo -= ev.yards;
    }
    code = ev.hit ? tierFor(ev.rarity).code : "w";
    if (s.down > 4) {
      s.phase = "over";
      s.result = "downs";
      ev.text += " Turnover on downs.";
    } else if (s.next >= nPlays) {
      s.phase = "over";
      s.result = "out";
      ev.text += " That's the game.";
    } else {
      s.phase = "ready";
    }
  }
  s.log.push({
    round: live.round, guesses: live.guesses, hit: ev.hit, rarity: Math.round(ev.rarity * 100) / 100,
    secs: Math.round(Math.min(secs, RULES.playClock) * 10) / 10, yards: ev.yards, code, text: ev.text,
  });
  ev.to = s.yl;
  ev.over = s.phase === "over";
  return { state: s, event: ev };
}

// ---- Presentation helpers --------------------------------------------------------
export function fieldSpot(yl) {
  if (yl === 50) return "50";
  return yl < 50 ? `OWN ${yl}` : `OPP ${100 - yl}`;
}

export function downText(s) {
  const ord = ["", "1st", "2nd", "3rd", "4th"][s.down] || "4th";
  const dist = s.toGo >= 100 - s.yl ? "Goal" : String(s.toGo);
  return `${ord} & ${dist}`;
}

/** Final outcome of a finished drive. `plays` is how many plays it took. */
export function summary(s) {
  const yards = s.result === "td" ? 100 - RULES.start : s.yl - RULES.start;
  const won = s.result === "td";
  return {
    points: s.points,
    yards,
    plays: s.log.length,
    label: won ? "TOUCHDOWN" : "NO SCORE",
    why: won ? `Touchdown drive in ${s.log.length} plays!` : s.result === "downs" ? "Turnover on downs." : "Out of plays.",
    won,
    codes: s.log.map((e) => e.code).join(""),
  };
}

/** One number that sorts drives: points, then yards, then fewer plays. */
export function driveRank(sum) {
  return sum.points * 1000000 + (sum.yards + 100) * 1000 + (100 - sum.plays);
}

export const CODE_EMOJI = { m: "🟨", g: "🟩", b: "💣", w: "⬜", t: "🏈" }; // check down, seam, bomb, incomplete, TD

// ---- Rarity -------------------------------------------------------------------------
/**
 * How deep a cut an answer is, 0 (the most obvious answer to this question) to
 * 1 (the least obvious), from our stats alone: each right answer carries an
 * "obviousness" weight (career fame, starts, seasons leading the team...).
 * Answers are ranked by it and spread evenly, so the most obvious answer gains
 * the fewest yards and the deepest cut the most. No crowd data needed, and the
 * same answer is always worth the same yards.
 */
export function rarityOf(id, prior) {
  const ids = Object.keys(prior);
  if (ids.length <= 1 || !(id in prior)) return ids.length <= 1 ? 1 : 0;
  // Rank = how many answers are more obvious than this one (ties share a rank).
  const above = ids.filter((k) => prior[k] > prior[id]).length;
  return above / (ids.length - 1);
}

/** Every right answer with the yards it's worth, deepest cuts first. */
export function answerYards(valid, prior) {
  return Object.entries(valid)
    .map(([id, v]) => {
      const tier = tierFor(rarityOf(id, prior));
      return { id, name: v.name, note: v.note, yards: tier.yards, tier: tier.key, tierName: tier.name };
    })
    .sort((a, b) => b.yards - a.yards || a.name.localeCompare(b.name));
}

/** How many answers to a question fall in each tier, e.g. { check: 4, seam: 3, bomb: 3 }. */
export function tierCounts(prior) {
  const out = { check: 0, seam: 0, bomb: 0 };
  for (const id of Object.keys(prior)) out[tierFor(rarityOf(id, prior)).key] += 1;
  return out;
}
