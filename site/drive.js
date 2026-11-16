// The rules of a drive. Pure functions with no browser or server APIs, so the
// browser (anonymous play, animations) and the server (signed-in play, the
// source of truth for leaderboards) always agree.
//
// Situation: 2:00 left in the 4th quarter, down 21-17, ball on your own 25.
// Every question is a play. Better answers gain more yards; wrong answers are
// incompletions or sacks. 4 downs to gain 10 yards. On 4th down you go for it
// or kick a field goal (if in range). A touchdown earns 6 and a choice of a
// 1-point kick or a 2-point try.

export const RULES = {
  start: 25, // own 25 (touchback)
  clock: 120, // seconds left in the game
  playClock: 25, // seconds to answer each question
  snap: 3, // clock used by every snap
  run: 6, // extra clock used when the ball is in play (a gain or a sack)
  fgMax: 55, // longest field goal attempt allowed
  hurryUp: 6, // answer within this many seconds...
  hurryBonus: 2, // ...for bonus yards on a gain
  them: 21,
  us: 17,
};

export const CALL_LABEL = {
  head_to_head: "Quick pass",
  odd_one_out: "Slant route",
  guess_number: "Deep shot",
  rank_four: "Run up the middle",
  who_am_i: "Flea flicker",
};

/** Yards gained for a graded answer (score 0-100) by play type. */
export function baseYards(type, score) {
  switch (type) {
    case "head_to_head": return score >= 100 ? 7 : 0;
    case "odd_one_out": return score >= 100 ? 12 : 0;
    case "guess_number": return score >= 100 ? 22 : score >= 60 ? 14 : score >= 30 ? 8 : score > 0 ? 4 : -5;
    case "rank_four": return score >= 100 ? 15 : score >= 50 ? 6 : score >= 25 ? 3 : -2;
    case "who_am_i": return score >= 100 ? 30 : score >= 50 ? 12 : -7;
  }
  return 0;
}

/** What each play type yields, for the help screen. */
export const YARDS_TABLE = [
  ["Quick pass", "head to head", "7 yds", "incomplete"],
  ["Slant route", "odd one out", "12 yds", "incomplete"],
  ["Deep shot", "guess the number", "up to 22 yds", "sack −5"],
  ["Run up the middle", "rank four", "up to 15 yds", "stuffed −2"],
  ["Flea flicker", "who am I?", "30 yds (12 on 2nd try)", "sack −7"],
];

export function newDrive() {
  return {
    yl: RULES.start, // yards from your own goal line (100 = touchdown)
    down: 1,
    toGo: 10,
    clock: RULES.clock,
    next: 0, // index of the next play question
    phase: "ready", // ready | decide | pat_choice | live | over
    live: null, // { kind: play|fg|pat1|pat2, round, servedAt, attempts, guesses }
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

/** Which question a live play uses. Plays come in order; point-afters are the last two. */
export function roundFor(kind, s, nPlays) {
  if (kind === "pat1") return nPlays;
  if (kind === "pat2") return nPlays + 1;
  return s.next;
}

/**
 * Start a play. kind: "play" (from ready, or "go for it" from decide),
 * "fg" (from decide, in range), "pat1"/"pat2" (from pat_choice).
 * Returns the new state, or null if that move isn't allowed now.
 */
export function snap(state, kind, now, nPlays) {
  const s = clone(state);
  const ok =
    (kind === "play" && (s.phase === "ready" || s.phase === "decide")) ||
    (kind === "fg" && s.phase === "decide" && canKick(s)) ||
    ((kind === "pat1" || kind === "pat2") && s.phase === "pat_choice");
  if (!ok) return null;
  if ((kind === "play" || kind === "fg") && s.next >= nPlays) return null;
  if (kind === "pat1") s.pat = "kick";
  if (kind === "pat2") s.pat = "two";
  s.phase = "live";
  s.live = { kind, round: roundFor(kind, s, nPlays), servedAt: now, attempts: 0, guesses: [] };
  return s;
}

function spotText(yl) {
  if (yl === 50) return "the 50";
  return yl < 50 ? `your own ${yl}` : `their ${100 - yl}`;
}

/**
 * Resolve the live play. Push the final guess onto state.live.guesses first.
 * `score` is the graded answer (0-100) or null if the play clock ran out. `secs` is how long the player took. Returns
 * { state, event } where event describes what happened, for animation.
 */
export function resolve(state, round, score, secs, nPlays) {
  const s = clone(state);
  const live = s.live;
  const kind = live.kind;
  const timedOut = score == null || secs > RULES.playClock;
  const t = Math.min(Math.max(0, secs), RULES.playClock);
  const from = s.yl;
  const ev = { kind, type: round.type, from, yards: 0, text: "", firstDown: false, score: timedOut ? 0 : score };
  s.live = null;
  if (kind === "play" || kind === "fg") s.next += 1;

  const logEntry = (code) => s.log.push({
    round: live.round, kind, type: round.type, guesses: live.guesses, score: ev.score,
    secs: Math.round(t * 10) / 10, yards: ev.yards, code, text: ev.text,
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
    const need = dist <= 35 ? 1 : dist <= 45 ? 50 : 100;
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
    let yards = baseYards(round.type, score);
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
    if (ev.yards === 0) ev.text = "Incomplete pass.";
    else if (ev.yards < 0) ev.text = round.type === "rank_four" ? `Stuffed for a loss of ${-ev.yards}.` : `Sacked! Loss of ${-ev.yards}.`;
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
  if (s.down > 4) {
    s.phase = "over";
    s.result = "downs";
    ev.text += " Turnover on downs.";
  } else if (s.clock <= 0) {
    s.clock = 0;
    s.phase = "over";
    s.result = "clock";
    ev.text += " That's the game. Time expired.";
  } else if (s.next >= nPlays) {
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
