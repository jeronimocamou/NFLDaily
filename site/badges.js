// Badges, worked out from a player's drive history (nothing extra is stored).
// Shared by the browser (anonymous players) and the server (signed-in players),
// so the same drives always earn the same badges.

import { tierFor } from "./drive.js";

export const BADGES = [
  { id: "first-td", emoji: "🏈", name: "Pay Dirt", desc: "Score your first touchdown" },
  { id: "bomb", emoji: "💣", name: "Bombs Away", desc: "Complete a Bomb" },
  { id: "three-bombs", emoji: "🎯", name: "Air Raid", desc: "Three Bombs in one drive" },
  { id: "fourth-down", emoji: "🧊", name: "Ice in the Veins", desc: "Convert on 4th down" },
  { id: "quick-td", emoji: "⚡", name: "Two-Minute Drill", desc: "Touchdown in 4 plays or fewer" },
  { id: "clean-td", emoji: "🧼", name: "Perfect Drive", desc: "Touchdown with no incompletions" },
  { id: "comeback", emoji: "🦾", name: "Never Say Die", desc: "Score after 3 straight incompletions" },
  { id: "streak-3", emoji: "🔥", name: "Heating Up", desc: "Play 3 days in a row" },
  { id: "streak-7", emoji: "📅", name: "Every Sunday", desc: "Play 7 days in a row" },
  { id: "streak-30", emoji: "🏟️", name: "Season Ticket", desc: "Play 30 days in a row" },
  { id: "drives-10", emoji: "🎽", name: "Starter", desc: "Finish 10 drives" },
  { id: "tds-10", emoji: "🏆", name: "Franchise QB", desc: "Score 10 touchdowns" },
];

/**
 * What happened on one finished drive, replayed from its log
 * (down and distance aren't stored per play, so they're recomputed here).
 */
export function driveFacts(log) {
  let down = 1;
  let toGo = 10;
  let yl = 25;
  let misses = 0;
  const f = { plays: log.length, td: false, bombs: 0, incompletions: 0, fourthDown: false, comeback: false };
  for (const e of log) {
    const was4th = down === 4;
    if (e.hit && tierFor(e.rarity).key === "bomb") f.bombs++;
    if (!e.yards) {
      f.incompletions++;
      misses++;
      down++;
      continue;
    }
    if (misses >= 3) f.comeback = true;
    misses = 0;
    yl = Math.min(100, yl + e.yards);
    if (yl >= 100 || e.code === "t") {
      f.td = true;
      if (was4th) f.fourthDown = true;
      break;
    }
    if (e.yards >= toGo) {
      if (was4th) f.fourthDown = true;
      down = 1;
      toGo = Math.min(10, 100 - yl);
    } else {
      down++;
      toGo -= e.yards;
    }
  }
  if (!f.td) f.comeback = false; // "score after..." means it has to end in a touchdown
  return f;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * drives: [{ date, onTime, log }] for finished drives (any order).
 * Returns { [badgeId]: date first earned }.
 */
export function earnedBadges(drives) {
  const out = {};
  const earn = (id, date) => {
    if (!out[id]) out[id] = date;
  };
  const sorted = [...drives].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let tds = 0;
  let run = 0;
  let prev = null;
  sorted.forEach((d, i) => {
    const f = driveFacts(d.log || []);
    if (f.td) {
      tds++;
      earn("first-td", d.date);
      if (f.plays <= 4) earn("quick-td", d.date);
      if (!f.incompletions) earn("clean-td", d.date);
      if (f.comeback) earn("comeback", d.date);
    }
    if (f.bombs >= 1) earn("bomb", d.date);
    if (f.bombs >= 3) earn("three-bombs", d.date);
    if (f.fourthDown) earn("fourth-down", d.date);
    if (tds >= 10) earn("tds-10", d.date);
    if (i + 1 >= 10) earn("drives-10", d.date);
    if (d.onTime) {
      run = prev && addDays(prev, 1) === d.date ? run + 1 : 1;
      prev = d.date;
      if (run >= 3) earn("streak-3", d.date);
      if (run >= 7) earn("streak-7", d.date);
      if (run >= 30) earn("streak-30", d.date);
    }
  });
  return out;
}
