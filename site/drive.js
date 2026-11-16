// The rules of a drive. Pure functions with no browser or server APIs, so the
// browser (anonymous play, animations) and the server (signed-in play, the
// source of truth for leaderboards) always agree.
//
// Situation: 2:00 left in the 4th quarter, down 21-17, ball on your own 25.
// Before every snap you call the play, and that decides the kind of question:
//   RUN        a closest-number question. Closer = more yards; way off = a loss.
//   PASS       name one of several right answers. Rarer answers gain more;
//              a wrong answer is an incomplete pass.
//   DEEP SHOT  name one of a few right answers (or the only one). Big gains,
//              but a miss is a sack.
// 4 downs to gain 10 yards. On 4th down you can also kick a field goal (it uses
// a run question: longer kicks need closer answers). A touchdown earns 6 and a
// choice of a 1-point kick or a 2-point try (quick multiple choice).

export const RULES = {
  start: 25, // own 25 (touchback)
  clock: 120, // seconds left in the game
  playClock: 25, // seconds to answer each question
  snap: 3, // clock used by every snap
  run: 6, // extra clock used when the ball is in play (a gain or a loss)
  fgMax: 55, // longest field goal attempt allowed
  hurryUp: 8, // answer within this many seconds...
  hurryBonus: 2, // ...for bonus yards on a gain
  them: 21,
  us: 17,
};

export const CALLS = ["run", "pass", "deep"];
export const CALL_LABEL = { run: "Run", pass: "Pass", deep: "Deep shot", fg: "Field goal", pat1: "Extra point", pat2: "Two-point try" };
export const CALL_BLURB = {
  run: "Guess a number. Closer = more yards (up to 12).",
  pass: "Name one. Rarer right answers gain more (4–18 yds). Wrong = incomplete.",
  deep: "Name one of a few. 12–30 yds, but a miss is a sack (−6).",
};

/**
 * Yards for a graded answer. `result` = { score 0-100, hit, rarity 0-1, far }.
 *   run:  score from closeness; `far` means way off.
 *   pass/deep: `hit` and how rare the answer was (1 = nobody else said it).
 */
export function baseYards(kind, result) {
  const { score = 0, hit = false, rarity = 0, far = false } = result || {};
  switch (kind) {
    case "run":
      if (score >= 100) return 12;
      if (score > 0) return Math.round(2 + (9 * score) / 100);
      return far ? -3 : 0;
    case "pass":
      return hit ? 4 + Math.round(14 * rarity) : 0;
    case "deep":
      return hit ? 12 + Math.round(18 * rarity) : -6;
  }
  return 0;
}

export function newDrive() {
  return {
    yl: RULES.start, // yards from your own goal line (100 = touchdown)
    down: 1,
    toGo: 10,
    clock: RULES.clock,
    used: { run: 0, pass: 0, deep: 0 }, // questions used from each part of the playbook
    phase: "ready", // ready | decide | pat_choice | live | over
    live: null, // { kind: run|pass|deep|fg|pat1|pat2, round, servedAt, attempts, guesses }
    points: 0,
    result: null, // td | fg | fg_miss | downs | clock
    pat: null, // kick | two, once chosen
    log: [],
  };
}

const clone = (s) => JSON.parse(JSON.stringify(s));
export const fgDistance = (s) => 100 - s.yl + 17;
export const canKick = (s) => fgDistance(s) <= RULES.fgMax;
const needsDecision = (s) => s.down === 4 || (s.clock <= 20 && canKick(s));

/** How many questions of each call are left. layout = puzzle.layout. */
export function playsLeft(s, layout) {
  const out = {};
  for (const c of CALLS) out[c] = Math.max(0, layout[c][1] - s.used[c]);
  return out;
}

/** Which question a play uses. A field goal uses the next run question. */
export function roundFor(kind, s, layout) {
  if (kind === "pat1" || kind === "pat2") return layout[kind];
  const call = kind === "fg" ? "run" : kind;
  return layout[call][0] + s.used[call];
}

/**
 * Start a play: "run" | "pass" | "deep" (from ready or decide), "fg" (from
 * decide, in range), "pat1" | "pat2" (from pat_choice). Returns the new
 * state, or null if that move isn't allowed now.
 */
export function snap(state, kind, now, layout) {
  const s = clone(state);
  const left = playsLeft(s, layout);
  const ok =
    (CALLS.includes(kind) && (s.phase === "ready" || s.phase === "decide") && left[kind] > 0) ||
    (kind === "fg" && s.phase === "decide" && canKick(s) && left.run > 0) ||
    ((kind === "pat1" || kind === "pat2") && s.phase === "pat_choice");
  if (!ok) return null;
  if (kind === "pat1") s.pat = "kick";
  if (kind === "pat2") s.pat = "two";
  s.phase = "live";
  s.live = { kind, round: roundFor(kind, s, layout), servedAt: now, attempts: 0, guesses: [] };
  return s;
}

/**
 * Resolve the live play. Push the final guess onto state.live.guesses first.
 * `result` is the graded answer ({ score, hit, rarity, far }) or null if the
 * play clock ran out. `secs` is how long the player took. Returns
 * { state, event } where event describes what happened, for animation.
 */
export function resolve(state, round, result, secs, layout) {
  const s = clone(state);
  const live = s.live;
  const kind = live.kind;
  const timedOut = result == null || secs > RULES.playClock;
  const t = Math.min(Math.max(0, secs), RULES.playClock);
  const from = s.yl;
  const score = timedOut ? 0 : result.score ?? 0;
  const ev = { kind, type: round.type, from, yards: 0, text: "", firstDown: false, score, hit: !timedOut && !!result.hit, rarity: timedOut ? 0 : result.rarity ?? 0 };
  s.live = null;
  if (CALLS.includes(kind)) s.used[kind] += 1;
  if (kind === "fg") s.used.run += 1;

  const logEntry = (code) => s.log.push({
    round: live.round, kind, type: round.type, guesses: live.guesses, score: ev.score, hit: ev.hit,
    rarity: Math.round(ev.rarity * 100) / 100, secs: Math.round(t * 10) / 10, yards: ev.yards, code, text: ev.text,
  });

  // Point after touchdown: the game clock doesn't matter any more.
  if (kind === "pat1" || kind === "pat2") {
    const good = !timedOut && (kind === "pat1" ? score >= 50 : score >= 100);
    if (good) s.points += kind === "pat1" ? 1 : 2;
    ev.text = kind === "pat1" ? (good ? "The extra point is good!" : "The extra point is no good!")
      : (good ? "Two-point conversion is good!" : "Two-point try fails!");
    ev.good = good;
    s.phase = "over";
    s.result = "td";
    logEntry(good ? "p" : "q");
    return { state: s, event: ev };
  }

  if (timedOut) {
    // Delay of game: 5 yards back, same down, and the question is burned.
    const back = Math.min(5, s.yl - 1);
    s.yl -= back;
    s.toGo += back;
    s.clock = Math.max(0, s.clock - RULES.playClock);
    ev.yards = -back;
    ev.text = `Delay of game! ${back ? `Back ${back} yards.` : ""}`.trim();
    ev.delay = true;
    logEntry("b");
  } else if (kind === "fg") {
    const dist = fgDistance(s);
    const need = dist <= 35 ? 1 : dist <= 45 ? 50 : 80;
    const good = score >= need;
    s.clock = Math.max(0, s.clock - (t + RULES.snap + 2));
    s.phase = "over";
    s.result = good ? "fg" : "fg_miss";
    if (good) s.points += 3;
    ev.good = good;
    ev.distance = dist;
    ev.text = good ? `The ${dist}-yard field goal is GOOD!` : `The ${dist}-yard field goal is no good.`;
    logEntry(good ? "k" : "x");
    return { state: s, event: ev };
  } else {
    let yards = baseYards(kind, result);
    if (yards > 0 && t <= RULES.hurryUp) {
      yards += RULES.hurryBonus;
      ev.hurry = true;
    }
    yards = Math.max(yards, 1 - s.yl); // can't go behind your own goal line
    s.clock = Math.max(0, s.clock - (t + RULES.snap + (yards !== 0 ? RULES.run : 0)));
    s.yl = Math.min(100, s.yl + yards);
    ev.yards = s.yl - from;
    if (s.yl >= 100) {
      s.points += 6;
      s.phase = "pat_choice";
      ev.td = true;
      ev.text = "TOUCHDOWN!";
      logEntry("t");
      ev.to = s.yl;
      return { state: s, event: ev };
    }
    if (ev.yards === 0) ev.text = kind === "run" ? "No gain." : "Incomplete pass.";
    else if (ev.yards < 0) ev.text = kind === "run" ? `Stuffed for a loss of ${-ev.yards}.` : `Sacked! Loss of ${-ev.yards}.`;
    else ev.text = ev.yards >= 20 ? `Big play! ${ev.yards} yards!` : `Gain of ${ev.yards}.`;
    if (ev.hurry) ev.text += " (+2 hurry-up)";
    if (ev.yards >= s.toGo) {
      s.down = 1;
      s.toGo = Math.min(10, 100 - s.yl);
      ev.firstDown = true;
      ev.text += " First down!";
    } else {
      s.down += 1;
      s.toGo -= ev.yards;
    }
    logEntry(ev.yards >= 10 ? "g" : ev.yards > 0 ? "m" : ev.yards === 0 ? "w" : "b");
  }

  ev.to = s.yl;
  const left = playsLeft(s, layout);
  if (s.down > 4) {
    s.phase = "over";
    s.result = "downs";
    ev.text += " Turnover on downs.";
  } else if (s.clock <= 0) {
    s.clock = 0;
    s.phase = "over";
    s.result = "clock";
    ev.text += " That's the game. Time expired.";
  } else if (!left.run && !left.pass && !left.deep) {
    s.phase = "over";
    s.result = "clock";
    ev.text += " That's the game.";
  } else {
    s.phase = needsDecision(s) ? "decide" : "ready";
  }
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

export function clockText(sec) {
  const v = Math.max(0, Math.ceil(sec));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

/** Final outcome of a finished drive. */
export function summary(s) {
  const yards = s.result === "td" ? 100 - RULES.start : s.yl - RULES.start;
  const label = s.result === "td" ? "TOUCHDOWN" : s.result === "fg" ? "FIELD GOAL" : "NO SCORE";
  const why = {
    td: s.points >= 8 ? "Touchdown plus the two-point conversion!" : s.points === 7 ? "Touchdown and the extra point!" : "Touchdown, but the point-after failed.",
    fg: "Field goal. Still down by 1.",
    fg_miss: "Missed field goal.",
    downs: "Turnover on downs.",
    clock: "Time ran out.",
  }[s.result] || "";
  const won = s.points >= RULES.them - RULES.us + 1;
  return { points: s.points, yards, clock: Math.round(s.clock), label, why, won, codes: s.log.map((e) => e.code).join("") };
}

/** One number that sorts drives: points, then yards, then time left. */
export function driveRank(sum) {
  return sum.points * 1000000 + (sum.yards + 100) * 1000 + sum.clock;
}

export const CODE_EMOJI = { g: "🟩", m: "🟨", w: "⬜", b: "🟥", t: "🏈", k: "🎯", x: "❌", p: "✅", q: "🚫" };

// ---- Rarity (name-one answers) -------------------------------------------------------
const PRIOR_N = 25; // how many "imaginary" answers the starting estimate is worth

/**
 * How rare an answer is, 0 (the most common answer) to 1 (nobody else said
 * it). Blends each answer's built-in obviousness (`prior` weights) with what
 * players actually answered (`counts`), so it works on day one and gets more
 * accurate as people play.
 */
export function rarityOf(id, prior, counts = {}) {
  const ids = Object.keys(prior);
  if (ids.length <= 1) return 1;
  const priorSum = ids.reduce((n, k) => n + prior[k], 0) || 1;
  const total = ids.reduce((n, k) => n + (counts[k] || 0), 0);
  const p = (k) => ((PRIOR_N * prior[k]) / priorSum + (counts[k] || 0)) / (PRIOR_N + total);
  const max = Math.max(...ids.map(p));
  return Math.max(0, Math.min(1, 1 - p(id) / max));
}
