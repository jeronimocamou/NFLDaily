import { startStadium } from "./stadium.js";
import { createFieldView } from "./fieldview.js";
import * as sound from "./sound.js";
import { RULES, CODE_EMOJI, TIERS, downText, driveRank, fieldSpot, isCurrent, newDrive, resolve, snap, summary, tierFor } from "./drive.js";

// Fourth & Daily client. Each day is one drive: down 21-17, ball on your own
// 25. Every play is one question: type a right answer to move the ball
// (less obvious answers gain more). 4 downs to gain 10 yards; reach the end
// zone to win. Signed-in drives run on the server (/api/drive), which times
// every play; anonymous drives run in the browser with the same rules
// (site/drive.js), graded by /api/answer and saved in localStorage.

const STORE_KEY = "nfldaily:v3";
const LEGACY_KEY = "nfldaily:v2"; // the original 5-round game

const $ = (sel, el = document) => el.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith("--")) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    } else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

// ---- Dates --------------------------------------------------------------------
function localISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return localISO(new Date(y, m - 1, d + n));
}
function prettyDate(iso, withYear = true) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: withYear ? "numeric" : undefined });
}

// ---- Storage (never fatal: private mode can throw) -------------------------------
function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}
function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* progress just won't persist */
  }
}

// ---- API ----------------------------------------------------------------------------
async function api(path, body) {
  const res = await fetch(`/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// ---- App state ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const today = localISO();
let date = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") || "") ? params.get("date") : today;
if (date > today) date = today;

let store = loadJSON(STORE_KEY, { drives: {} });
if (!store.drives) store = { drives: {} };
const legacy = loadJSON(LEGACY_KEY, { games: {} });
let account = { enabled: false, user: null, stats: null };
let puzzle = null; // anonymous: every question (no answers); signed in: { number, plays }
let drive = null; // engine state (site/drive.js)
let qdata = {}; // per question index: { done, hit, rarity, guesses, reveal, answers, error }
let qcache = {}; // signed in: questions as they were served
let lastPlay = null; // { idx, event } for the result card
let liveStart = 0; // local time the live play was snapped
let busy = false;
let animating = false;
let showFinal = false;

const signedIn = () => Boolean(account.user);
const nPlays = () => (puzzle.rounds ? puzzle.rounds.length : puzzle.plays);
const roundAt = (i) => (puzzle.rounds ? puzzle.rounds[i] : qcache[i]);

const stadium = startStadium($("#stadium"));
const field = createFieldView($("#field"), {
  onCatch: () => sound.pop(),
  onIncomplete: () => sound.thud(),
  onFirstDown: () => sound.chime(),
  onBomb: () => {
    sound.roar(false);
    shake();
    confetti(18);
  },
  onTouchdown: () => {
    sound.roar(true);
    confetti(70);
    stadium.cheer();
  },
});

// ---- Celebrations ---------------------------------------------------------------------------------
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

function shake() {
  if (reduceMotion.matches) return;
  const hud = $("#game-hud");
  hud.classList.remove("shake");
  void hud.offsetWidth; // restart the animation
  hud.classList.add("shake");
}

/** Pixel confetti falling over the scoreboard. */
function confetti(n) {
  if (reduceMotion.matches) return;
  const colors = ["#ffd23f", "#ff6b5a", "#5ef08a", "#4aa3ff", "#f4f4ec", "#ff9a3c"];
  const box = h("div", { class: "confetti", "aria-hidden": "true" });
  for (let i = 0; i < n; i++) {
    box.append(h("i", { style: {
      left: `${Math.random() * 100}%`, background: colors[i % colors.length],
      "--d": `${0.9 + Math.random() * 1.1}s`, "--x": `${(Math.random() - 0.5) * 80}px`, "--delay": `${Math.random() * 0.3}s`,
    } }));
  }
  $("#game-hud").append(box);
  setTimeout(() => box.remove(), 2600);
}

// ---- Teams: your favorite (left end zone, jerseys) and today's opponent (right) ---------------------
const TEAM_KEY = "nfldaily:team";
let favorite = null;
try { favorite = localStorage.getItem(TEAM_KEY); } catch { /* ignore */ }

function teamInfo(code) {
  const t = names?.teams.find((x) => x[0] === code);
  return t ? { code: t[0], name: t[1], c1: t[3], c2: t[4] } : null;
}

/** The same opponent for everyone each day (never your own team). */
function opponentFor(day) {
  const list = (names?.teams || []).filter((t) => t[0] !== favorite);
  if (!list.length) return null;
  let hash = 0;
  for (const ch of day) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return teamInfo(list[hash % list.length][0]);
}

async function applyTeams() {
  await loadNames().catch(() => null);
  const mine = (favorite && teamInfo(favorite)) || { code: "", c1: "#1d3f8a", c2: "#f4f4ec" };
  const them = opponentFor(date) || { code: "", c1: "#b3262e", c2: "#f4f4ec" };
  field.setTeams({ mine, them });
  $("#sb-us-label").textContent = mine.code || "YOU";
  $("#sb-them-label").textContent = them.code || "THEM";
  $("#sb-them-label").title = them.name || "";
}

function teamPicker() {
  const select = h("select", { class: "team-select", "aria-label": "Your team" },
    h("option", { value: "" }, "No favorite team"),
    (names?.teams || []).map((t) => h("option", { value: t[0], selected: t[0] === favorite }, t[1])));
  select.addEventListener("change", () => {
    favorite = select.value || null;
    try { favorite ? localStorage.setItem(TEAM_KEY, favorite) : localStorage.removeItem(TEAM_KEY); } catch { /* ignore */ }
    applyTeams();
  });
  return h("label", { class: "team-pick" }, h("span", {}, "Your team (end zone and jerseys)"), select);
}

function setupMute() {
  const btn = $("#mute-btn");
  const paint = () => {
    btn.textContent = sound.isMuted() ? "🔇" : "🔊";
    btn.setAttribute("aria-label", sound.isMuted() ? "Unmute sounds" : "Mute sounds");
  };
  btn.addEventListener("click", () => {
    sound.setMuted(!sound.isMuted());
    if (!sound.isMuted()) {
      sound.unlock();
      sound.chime();
    }
    paint();
  });
  paint();
}

// ---- Drive replay ----------------------------------------------------------------------------------
async function replayDrive() {
  if (animating || !drive?.log.length) return;
  animating = true;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
  field.setSpeed(0.85);
  let s = { yl: RULES.start, toGo: 10, down: 1 };
  field.draw({ ...s, phase: "ready" });
  await new Promise((res) => setTimeout(res, 500));
  for (const [k, e] of drive.log.entries()) {
    const before = { ...s, phase: "ready" };
    const td = e.code === "t";
    const yl = Math.min(100, s.yl + e.yards);
    const firstDown = !td && e.yards >= s.toGo;
    const next = firstDown ? { yl, toGo: Math.min(10, 100 - yl), down: 1 } : { yl, toGo: s.toGo - e.yards, down: s.down + 1 };
    $("#sb-clock").textContent = String(k + 1);
    sound.whistle();
    await new Promise((res) => setTimeout(res, 250));
    await field.animate({ yards: e.yards, rarity: e.rarity, hit: e.hit, td, firstDown, timedOut: !e.hit && !e.guesses?.length }, before, { ...next, phase: td ? "over" : "ready" });
    s = next;
  }
  field.setSpeed(1);
  animating = false;
  render();
}

function persistLocal() {
  if (signedIn()) return;
  const d = (store.drives[date] = store.drives[date] || {});
  Object.assign(d, { state: drive, q: qdata, last: lastPlay });
  if (drive.phase === "over" && d.onTime == null) d.onTime = date === localISO();
  saveStore();
}

// ---- Scoreboard and timer ---------------------------------------------------------------------
function elapsed() {
  return drive?.phase === "live" ? (Date.now() - liveStart) / 1000 : 0;
}

function updateHud() {
  if (!drive) return;
  $("#game-hud").hidden = false;
  $("#sb-us").textContent = String(RULES.us + drive.points);
  $("#sb-them").textContent = String(RULES.them);
  $("#sb-clock").textContent = `${drive.log.length + (drive.phase === "live" ? 1 : 0)}`;
  $("#sb-down").textContent = drive.phase === "over" ? "FINAL" : downText(drive);
  $("#sb-spot").textContent = drive.phase === "over" ? `${summary(drive).yards} YDS` : `BALL ${fieldSpot(drive.yl)}`;
  const pc = $("#sb-play");
  if (drive.phase === "live") {
    const left = Math.max(0, RULES.playClock - elapsed());
    pc.textContent = `:${String(Math.ceil(left)).padStart(2, "0")}`;
    pc.classList.toggle("urgent", left <= 5);
    pc.hidden = false;
    const bar = $("#playclock-bar");
    if (bar) bar.style.transform = `scaleX(${left / RULES.playClock})`;
  } else {
    pc.hidden = true;
  }
}

let ticker = null;
let timedOut = false;
function startTicker() {
  clearInterval(ticker);
  timedOut = false;
  ticker = setInterval(() => {
    updateHud();
    if (drive?.phase === "live" && !busy && !timedOut && elapsed() > RULES.playClock) {
      timedOut = true;
      answer(drive.live.round, null);
    }
  }, 200);
}

// ---- Cards ------------------------------------------------------------------------------------
/** After a play: one big line (tier and yards), your answer, and nothing else. */
function playResult(round, st, i) {
  const ev = lastPlay?.idx === i ? lastPlay.event : null;
  const guess = st.guesses?.at(-1);
  const yours = guess ? (st.answers?.find((a) => a.id === guess)?.name || nameFor(round.answer_kind, guess) || "Your answer") : null;
  let big, cls, sub;
  if (st.hit) {
    const tier = tierFor(st.rarity);
    big = ev?.td ? "🏈 TOUCHDOWN" : `${TIER_EMOJI[tier.key]} ${tier.name.toUpperCase()} +${tier.yards}`;
    cls = ev?.td ? "td" : tier.key;
    sub = `✓ ${yours}${ev?.firstDown && !ev?.td ? " · First down!" : ""}`;
  } else {
    big = "INCOMPLETE";
    cls = "miss";
    sub = st.timedOut || !guess ? "Time ran out" : `✗ ${yours}`;
  }
  const over = ev?.over && !ev?.td ? (drive.result === "downs" ? " · Turnover on downs" : " · That's the game") : "";
  return h("div", { class: `play-result pr-${cls}` },
    h("div", { class: "pr-big" }, big),
    h("div", { class: "pr-sub" }, sub + over));
}

function errorLine(msg) {
  return h("p", { class: "error", role: "alert" }, msg);
}

/** The one button: snap the next play, or see the final. */
function nextButton() {
  const dis = busy || animating;
  if (drive.phase === "over") {
    return h("button", { type: "button", class: "btn primary", disabled: dis, onclick: () => { showFinal = true; render(); } }, "See the final ▶");
  }
  return h("button", { type: "button", class: "btn primary", disabled: dis, onclick: () => act() },
    drive.log.length ? `Next play: ${downText(drive)} ▶` : "Snap the ball ▶");
}

function roundShell(round, i, ...body) {
  const live = drive.phase === "live" && drive.live.round === i;
  const n = live ? drive.log.length + 1 : drive.log.findIndex((e) => e.round === i) + 1;
  return h("article", { class: `card ${live ? "live" : ""}` },
    live ? h("div", { class: "playclock" }, h("div", { id: "playclock-bar" })) : null,
    h("div", { class: "round-label" }, h("span", {}, `Play ${n} · ${live ? downText(drive) : "result"}`), h("span", { class: "season-chip" }, String(round.season))),
    h("h2", { class: `prompt ${live ? "" : "small"}` }, round.prompt),
    live && round.hint ? h("p", { class: "hint" }, round.hint) : null,
    live ? tierLine(round) : null,
    ...body);
}

// ---- Type-ahead answers ("name one" plays) -------------------------------------------------
let names = null;
const normName = (x) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

async function loadNames() {
  if (names) return names;
  const data = await (await fetch("/names.json")).json();
  names = {
    teams: data.teams,
    player: data.players.map(([id, name, pos, start, end]) => ({
      id, name, sub: `${pos} · ${start === end ? start : `${start}–${end}`}`, key: normName(name), span: end - start,
    })),
    team: data.teams.flatMap(([id, name, aliases]) => [
      { id, name, sub: "", key: normName(name), span: 99 },
      ...aliases.map((a) => ({ id, name: a, sub: `now the ${name}`, key: normName(a), span: 0 })),
    ]),
  };
  return names;
}

function searchNames(kind, q) {
  const qn = normName(q);
  if (!qn || !names) return [];
  const parts = qn.split(" ");
  const out = names[kind].filter((n) => {
    const words = n.key.split(" ");
    return parts.every((part) => words.some((w) => w.startsWith(part)));
  });
  out.sort((a, b) => (b.key.startsWith(qn) - a.key.startsWith(qn)) || (b.span - a.span) || a.name.localeCompare(b.name));
  return out.slice(0, 7);
}

const nameFor = (kind, id) => names?.[kind]?.find((n) => n.id === id)?.name;

const TIER_EMOJI = { check: "🟨", seam: "🟩", bomb: "💣" };

/** "4 check-downs · 3 seams · 3 bombs" under each question. */
function tierLine(round) {
  if (!round.tiers) return null;
  const parts = [
    [round.tiers.bomb, "bomb", "bombs"],
    [round.tiers.seam, "seam", "seams"],
    [round.tiers.check, "check-down", "check-downs"],
  ].filter(([n]) => n).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return h("p", { class: "tier-line" }, parts.join(" · "));
}

function renderQuestion(round, i) {
  const st = qdata[i] || {};
  const body = [];
  if (round.clues) body.push(h("ul", { class: "clues" }, round.clues.map((c) => h("li", {}, c))));
  if (!st.done) {
    let picked = null;
    let results = [];
    let active = 0;
    const listId = `sugg-${i}`;
    const input = h("input", {
      type: "text", class: "answer-input", placeholder: round.answer_kind === "team" ? "Type a team…" : "Type a player…",
      autocomplete: "off", autocapitalize: "words", spellcheck: "false", enterkeyhint: "go",
      role: "combobox", "aria-label": "Your answer", "aria-expanded": "false", "aria-controls": listId, "aria-autocomplete": "list",
    });
    const list = h("ul", { class: "suggestions", id: listId, role: "listbox" });
    const submit = h("button", { type: "button", class: "btn primary", disabled: true }, "Throw it ▶");
    const draw = () => {
      list.replaceChildren(...results.map((n, k) => h("li", {
        role: "option", id: `${listId}-${k}`, class: k === active ? "active" : "", "aria-selected": String(k === active),
        onmousedown: (e) => { e.preventDefault(); choose(n); },
      }, h("span", { class: "n" }, n.name), n.sub ? h("span", { class: "s" }, n.sub) : null)));
      input.setAttribute("aria-expanded", String(results.length > 0));
      if (results.length) input.setAttribute("aria-activedescendant", `${listId}-${active}`);
      else input.removeAttribute("aria-activedescendant");
    };
    const choose = (n) => {
      picked = n;
      input.value = n.name;
      results = [];
      draw();
      submit.disabled = false;
    };
    input.addEventListener("input", async () => {
      picked = null;
      submit.disabled = true;
      await loadNames().catch(() => null);
      results = searchNames(round.answer_kind, input.value);
      active = 0;
      draw();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { active = Math.min(results.length - 1, active + 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (picked) answer(i, picked.id);
        else if (results[active]) choose(results[active]);
      }
    });
    submit.addEventListener("click", () => picked && answer(i, picked.id));
    body.push(h("div", { class: "answer-box" }, input, list), submit);
    if (st.error) body.push(errorLine(st.error));
    setTimeout(() => input.focus({ preventScroll: true }), 50);
  } else {
    body.push(playResult(round, st, i), nextButton());
  }
  return roundShell(round, i, ...body);
}

/** Before the first snap, or when coming back mid-drive. */
function huddleCard() {
  const intro = drive.log.length === 0;
  return h("article", { class: "card huddle" },
    h("div", { class: "round-label" }, h("span", {}, intro ? "The situation" : "Huddle"), h("span", { class: "season-chip" }, `#${puzzle.number}`)),
    intro
      ? h("div", {},
          h("h2", { class: "prompt" }, "Down 21-17. Your ball on the 25. Go win it."),
          h("p", {}, "Every play is a question. Type a right answer to move the ball. The obvious answers are a check-down (10 yards, always a first down), less obvious ones a seam route (20), and the deepest cuts are the bomb (40). A wrong answer is an incomplete pass."),
          h("p", {}, "You have 4 downs to gain 10 yards. Reach the end zone to win."))
      : h("h2", { class: "prompt" }, `${downText(drive)} at ${fieldSpot(drive.yl)}.`),
    nextButton());
}

// ---- Playing ----------------------------------------------------------------------------------
function applyServer(r) {
  if (r.now && r.state?.phase === "live") liveStart = Date.now() - (r.now - r.state.live.servedAt);
  drive = r.state;
  if (r.question) qcache[r.question.index] = r.question;
}

async function act() {
  if (busy || animating) return;
  busy = true;
  sound.unlock();
  sound.whistle();
  try {
    if (signedIn()) {
      applyServer(await api("drive", { date, action: "play" }));
    } else {
      const next = snap(drive, Date.now(), nPlays());
      if (!next) throw new Error("You can't do that right now.");
      drive = next;
      liveStart = drive.live.servedAt;
      persistLocal();
    }
    lastPlay = null;
    startTicker();
  } catch (e) {
    alert(e.message);
  } finally {
    busy = false;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

async function answer(i, guess) {
  if (busy || animating || drive?.phase !== "live" || drive.live.round !== i) return;
  busy = true;
  const prev = qdata[i] || {};
  try {
    if (signedIn()) {
      const r = await api("drive", { date, action: "answer", guess });
      if (!r.event) throw new Error(r.notice || "Something went wrong.");
      await finishPlay(i, r.state, r.event, r.reveal, guess == null ? [] : [guess], r.answers);
      return;
    }
    const s = structuredClone(drive);
    if (guess == null) {
      const { state, event } = resolve(s, roundAt(i), null, RULES.playClock + 2, nPlays());
      await finishPlay(i, state, event, null, []);
      return;
    }
    const view = await api("answer", { date, round: i, guess, attempt: 1 });
    s.live.guesses = [guess];
    const { state, event } = resolve(s, roundAt(i), view.result, (Date.now() - liveStart) / 1000, nPlays());
    await finishPlay(i, state, event, view.reveal, [guess], view.answers);
  } catch (e) {
    qdata[i] = { ...prev, error: e.message };
  } finally {
    busy = false;
    render();
  }
}

async function finishPlay(i, state, event, reveal, guesses, answers = null) {
  clearInterval(ticker);
  const before = drive;
  qdata[i] = { done: true, hit: event.hit, rarity: event.rarity, guesses, reveal, answers, timedOut: event.timedOut };
  drive = state;
  lastPlay = { idx: i, event };
  persistLocal();
  busy = false;
  animating = true;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
  await field.animate(event, before, state);
  animating = false;
  if (drive.phase === "over") await onDriveOver();
  render();
}

async function onDriveOver() {
  if (signedIn()) {
    loadRecap();
    await refreshAccount();
  } else if (account.enabled) {
    api("stats", { date, log: drive.log }).catch(() => {});
  }
  updateStreak();
  $("#streak")?.classList.add("bump");
  setTimeout(() => $("#streak")?.classList.remove("bump"), 900);
}

// ---- End-of-drive recap ----------------------------------------------------------------------
let recap = {}; // question index -> every right answer with its tier (signed-in, from /api/recap)

/** Every right answer to one question, grouped by tier, with yours highlighted. */
function recapAnswers(answers, e) {
  const yourId = e.hit ? e.guesses?.[0] : null;
  const groups = [...TIERS].reverse().map((t) => {
    const items = answers.filter((a) => a.tier === t.key);
    if (!items.length) return null;
    return h("div", { class: "tier-group" },
      h("p", { class: `tier-head tier-${t.key}` }, `${TIER_EMOJI[t.key]} ${t.name}`, h("span", {}, `+${t.yards}`)),
      h("ul", { class: "recap-names" }, items.map((a) =>
        h("li", { class: a.id === yourId || a.yours ? "yours" : "" }, a.name))));
  });
  const missed = !e.hit && e.guesses?.[0] ? h("p", { class: "recap-miss" }, `You said ${nameFor("player", e.guesses[0]) || nameFor("team", e.guesses[0]) || "something else"}`) : null;
  return h("div", { class: "recap-body" }, missed, groups);
}

async function loadRecap() {
  if (!signedIn() || drive?.phase !== "over") return;
  if (drive.log.every((e) => recap[e.round] || qdata[e.round]?.answers)) return;
  try {
    recap = (await api(`recap?date=${date}`)).recap || {};
    if (!animating) render();
  } catch {
    /* the recap is a nice-to-have */
  }
}

// ---- Sharing and friend challenges --------------------------------------------------------------
const SHARE_RE = /^(\d{1,4})-(\d)-(-?\d{1,2})-(\d{1,3})-([a-z]{1,40})(?:-s(\d{1,4}))?$/;

function parseShare(code) {
  const m = SHARE_RE.exec(code || "");
  if (!m) return null;
  return { code, number: +m[1], points: +m[2], yards: +m[3], plays: +m[4], codes: m[5], streak: m[6] ? +m[6] : 0 };
}

function buildShareText(sum, streak, url) {
  const grid = sum.codes.split("").map((c) => CODE_EMOJI[c] || "").join("");
  const head = sum.won ? `TOUCHDOWN! Won ${RULES.us + sum.points}–${RULES.them}` : `${sum.yards} yds · came up short`;
  return [
    `🏈 Fourth & Daily #${puzzle.number}`,
    head,
    `${grid} ${sum.plays} play${sum.plays === 1 ? "" : "s"}`,
    streak > 1 ? `🔥 ${streak}-day streak` : null,
    `Beat my drive 👉 ${url}`,
  ].filter(Boolean).join("\n");
}

// A friend's drive from a shared link (?vs=CODE), kept for that puzzle.
let challenge = null;
function loadChallenge() {
  const fromUrl = params.get("vs");
  if (fromUrl && parseShare(fromUrl)) {
    try { localStorage.setItem("nfldaily:vs", fromUrl); } catch { /* ignore */ }
    const q = new URLSearchParams(location.search);
    q.delete("vs");
    history.replaceState(null, "", location.pathname + (q.toString() ? `?${q}` : ""));
  }
  let code = fromUrl;
  if (!code) { try { code = localStorage.getItem("nfldaily:vs"); } catch { code = null; } }
  challenge = parseShare(code);
}

const chartOf = (codes) => codes.split("").map((c) => CODE_EMOJI[c] || "").join("");

function challengeBanner() {
  if (!challenge || !puzzle) return null;
  const theirs = challenge.points ? `a touchdown in ${challenge.plays} plays` : `${challenge.yards} yards in ${challenge.plays} plays`;
  if (challenge.number !== puzzle.number) {
    const target = addDays(date, challenge.number - puzzle.number);
    if (target > today || drive?.phase === "over") return null;
    return h("p", { class: "banner challenge" }, `🆚 A friend went for ${theirs} on drive #${challenge.number}. `,
      h("a", { href: target === today ? "./" : `./?date=${target}` }, "Play that drive →"));
  }
  return h("div", { class: "banner challenge" },
    h("strong", {}, "🆚 Beat your friend's drive"),
    h("div", {}, `${chartOf(challenge.codes)} · ${theirs}`));
}

function challengeCompare(sum) {
  if (!challenge || challenge.number !== puzzle.number) return null;
  const mine = driveRank(sum);
  const theirs = driveRank({ points: challenge.points, yards: challenge.yards, plays: challenge.plays });
  const verdict = mine > theirs ? "🏆 You beat your friend's drive!" : mine === theirs ? "🤝 Dead even with your friend." : "😬 Your friend's drive was better.";
  const line = (who, s) => h("div", { class: "vs-row" }, h("span", {}, who), h("span", {}, chartOf(s.codes)), h("strong", {}, s.points ? `TD · ${s.plays} plays` : `${s.yards} yds`));
  return h("div", { class: "vs-card" }, h("p", { class: "vs-verdict" }, verdict),
    line("You", sum), line("Friend", challenge));
}

// ---- Streak ----------------------------------------------------------------------------------------
function currentStreak() {
  return (signedIn() && account.stats ? account.stats.streak : localStats().streak) || 0;
}

function updateStreak() {
  const el = $("#streak");
  if (!el) return;
  const n = currentStreak();
  el.textContent = `🔥 ${n}`;
  el.classList.toggle("cold", n === 0);
  el.title = n ? `${n}-day streak` : "Play today to start a streak";
}

// ---- The final ----------------------------------------------------------------------------------
function renderSummary() {
  const sum = summary(drive);
  const us = RULES.us + sum.points;
  const grid = sum.codes.split("").map((c) => CODE_EMOJI[c]).join("");
  const toast = h("p", { class: "toast", role: "status" });
  const streak = currentStreak();
  const code = `${puzzle.number}-${sum.points}-${sum.yards}-${sum.plays}-${sum.codes || "w"}${streak > 1 ? `-s${streak}` : ""}`;
  const url = `${location.origin}/s/${code}`;
  const shareText = buildShareText(sum, streak, url);

  const share = async () => {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      // Attach the scoreboard picture where the share sheet supports files.
      try {
        const blob = await (await fetch(`/api/og?c=${code}`)).blob();
        const file = new File([blob], `fourth-and-daily-${puzzle.number}.png`, { type: "image/png" });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], text: shareText });
          return;
        }
      } catch (e) {
        if (e.name === "AbortError") return;
      }
      try {
        await navigator.share({ text: shareText });
        return;
      } catch (e) {
        if (e.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(shareText);
      toast.textContent = "Copied to clipboard!";
    } catch {
      toast.textContent = "Couldn't copy. Select and copy the text above.";
    }
  };

  const nextIn = h("p", { class: "next-in" });
  const tick = () => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const s = Math.max(0, Math.floor((midnight - now) / 1000));
    const p = (n) => String(n).padStart(2, "0");
    nextIn.textContent = `Next drive in ${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  };
  tick();
  clearInterval(renderSummary.timer);
  renderSummary.timer = setInterval(tick, 1000);

  const cta = account.enabled && !signedIn()
    ? h("p", { class: "cta" }, "Want to be on the leaderboard? ", h("button", { type: "button", class: "link", onclick: openProfile }, "Create a free account"), " before tomorrow's drive.")
    : null;

  const plays = drive.log.map((e, k) => {
    const round = roundAt(e.round);
    const answers = recap[e.round] || qdata[e.round]?.answers;
    const head = h("summary", {},
      h("span", { class: "rc-what" }, `${CODE_EMOJI[e.code]} ${round?.prompt || `Play ${k + 1}`}`),
      h("span", { class: "score" }, e.yards ? `+${e.yards}` : "inc."));
    return h("li", {}, answers?.length
      ? h("details", { class: "recap" }, head, recapAnswers(answers, e))
      : h("div", { class: "recap-plain" }, head.childNodes[0], head.childNodes[1]));
  });

  return h("article", { class: "card summary" },
    h("div", { class: "round-label" }, h("span", {}, `Drive #${puzzle.number}`), h("span", {}, prettyDate(date))),
    h("p", { class: "big" }, sum.label),
    h("p", { class: "final-score" }, `YOU ${us} – ${RULES.them} THEM`),
    h("p", { class: "out-of" }, `${sum.won ? "You win! " : "Final. "}${sum.why}`),
    h("p", { class: "drive-line" }, `${sum.yards} yds in ${sum.plays} plays`),
    streak > 1 ? h("p", { class: "streak-line" }, `🔥 ${streak}-day streak`) : null,
    challengeCompare(sum),
    h("div", { class: "grid", "aria-label": "Drive chart" }, grid),
    h("button", { type: "button", class: "btn primary", onclick: share }, "Share your drive"),
    toast,
    cta,
    h("p", { class: "recap-title" }, "Your drive · tap a play to see every right answer"),
    h("ol", { class: "summary-list recap-list" }, plays),
    h("button", { type: "button", class: "btn replay-btn", disabled: animating, onclick: replayDrive }, "▶ Replay your drive"),
    h("div", { class: "row-btns" },
      h("button", { type: "button", class: "btn", onclick: () => openLeaderboard() }, "Leaderboard"),
      h("button", { type: "button", class: "btn", onclick: openArchive }, "Past drives")),
    installPrompt(),
    date === today ? nextIn : null);
}

// ---- Flow ---------------------------------------------------------------------------------------
function render() {
  if (!puzzle || !drive) return;
  updateHud();
  if (!animating) field.draw(drive);
  let card;
  if (drive.phase === "over" && (showFinal || !lastPlay)) card = renderSummary();
  else if (drive.phase === "live" && roundAt(drive.live.round)) card = renderQuestion(roundAt(drive.live.round), drive.live.round);
  else if (lastPlay && roundAt(lastPlay.idx)) card = renderQuestion(roundAt(lastPlay.idx), lastPlay.idx);
  else card = huddleCard();
  $("#stage").replaceChildren(card);
}

function renderBanner() {
  const banner = $("#banner");
  const vs = challengeBanner();
  if (date === today) return banner.replaceChildren(...(vs ? [vs] : []));
  banner.replaceChildren(
    h("p", { class: "banner" }, `Archive drive from ${prettyDate(date)}. It won't count toward streaks or leaderboards. `,
      h("a", { href: "./" }, "Play today's →")),
    ...(vs ? [vs] : []),
  );
}

async function loadPuzzle() {
  const data = await api(`puzzle?date=${date}`);
  puzzle = data.puzzle;
  qdata = {};
  qcache = {};
  lastPlay = null;
  if (data.user) {
    account.user = data.user;
    const r = await api(`drive?date=${date}`);
    applyServer(r);
    for (const e of drive.log) qdata[e.round] = { done: true, hit: e.hit, rarity: e.rarity, guesses: e.guesses || [] };
  } else {
    let saved = store.drives[date];
    // Drives saved under older rules start over (finished ones are kept).
    if (saved?.state && !isCurrent(saved.state) && saved.state.phase !== "over") saved = null;
    drive = saved?.state || newDrive();
    qdata = saved?.q || {};
    lastPlay = saved?.last || null;
    if (drive.phase === "live") liveStart = drive.live.servedAt;
  }
  showFinal = drive.phase === "over";
  recap = {};
  if (drive.phase === "over") loadRecap();
  $("#puzzle-meta").textContent = `#${puzzle.number} · ${prettyDate(date)}`;
  renderBanner();
  render();
  if (drive.phase === "live") startTicker();
}

// ---- Stats & account ------------------------------------------------------------------------------
function localStats() {
  const done = Object.entries(store.drives).filter(([, d]) => d.state?.phase === "over");
  const sums = done.map(([d, x]) => ({ ...summary(x.state), date: d, onTime: x.onTime }));
  const onTime = new Set(sums.filter((s) => s.onTime).map((s) => s.date));
  let streak = 0;
  for (let d = onTime.has(today) ? today : addDays(today, -1); onTime.has(d); d = addDays(d, -1)) streak++;
  let best = 0;
  for (const d of onTime) {
    if (onTime.has(addDays(d, -1))) continue;
    let run = 0;
    for (let x = d; onTime.has(x); x = addDays(x, 1)) run++;
    best = Math.max(best, run);
  }
  const legacyPlayed = Object.values(legacy.games || {}).filter((g) => g.completed).length;
  const top = sums.reduce((b, s) => (!b || driveRank(s) > driveRank(b) ? s : b), null);
  return {
    played: sums.length + legacyPlayed,
    drives: sums.length,
    tds: sums.filter((s) => s.points >= 6).length,
    avgYards: sums.length ? Math.round(sums.reduce((n, s) => n + s.yards, 0) / sums.length) : 0,
    bestDrive: top ? { points: top.points, yards: top.yards, clock: top.plays } : null,
    streak,
    best,
  };
}

async function refreshAccount() {
  try {
    account = await api(`account?today=${today}`);
  } catch {
    account = { enabled: false, user: null, stats: null };
  }
}

function authForm() {
  let mode = "signup";
  const err = h("p", { class: "error", role: "alert" });
  const user = h("input", { name: "username", autocomplete: "username", required: true, minlength: 3, maxlength: 20, pattern: "[A-Za-z0-9_]+", placeholder: "Username" });
  const pass = h("input", { name: "password", type: "password", autocomplete: "new-password", required: true, minlength: 8, placeholder: "Password (8+ characters)" });
  const submit = h("button", { type: "submit", class: "btn primary" }, "Create account");
  const toggle = h("button", { type: "button", class: "link" });
  const title = h("h3", {});
  const setMode = (m) => {
    mode = m;
    title.textContent = m === "signup" ? "Create an account" : "Sign in";
    submit.textContent = m === "signup" ? "Create account" : "Sign in";
    pass.setAttribute("autocomplete", m === "signup" ? "new-password" : "current-password");
    toggle.textContent = m === "signup" ? "Already have an account? Sign in" : "New here? Create an account";
    err.textContent = "";
  };
  toggle.addEventListener("click", () => setMode(mode === "signup" ? "login" : "signup"));
  setMode("signup");

  const form = h("form", { class: "auth" }, title,
    h("p", { class: "hint" }, "Save your stats across devices and get on the leaderboard. Just a username, no email needed. Drives played before signing in stay on this device."),
    h("label", {}, h("span", {}, "Username"), user),
    h("label", {}, h("span", {}, "Password"), pass),
    err, submit, toggle);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    err.textContent = "";
    try {
      await api("account", { action: mode, username: user.value.trim(), password: pass.value });
      await refreshAccount();
      await loadPuzzle();
      renderProfile();
      handleJoinLink();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

function renderProfile() {
  const s = signedIn() && account.stats ? account.stats : localStats();
  const stat = (n, l) => h("div", {}, h("div", { class: "n" }, String(n)), h("div", { class: "l" }, l));
  const b = s.bestDrive;
  const parts = [
    h("div", { class: "stat-row" }, stat(s.played, "Played"), stat(s.tds, "Touchdowns"), stat(s.streak, "Streak"), stat(s.best, "Best streak")),
    h("p", { class: "hint center" }, s.drives
      ? `Average drive: ${s.avgYards} yds · Best: ${b.yards} yds in ${b.clock} plays`
      : "No drives yet."),
  ];
  if (signedIn()) {
    parts.unshift(h("p", { class: "signed-in" }, "Signed in as ", h("strong", {}, account.user.username)));
    parts.push(h("button", { type: "button", class: "btn", onclick: async () => {
      await api("account", { action: "logout" }).catch(() => {});
      await refreshAccount();
      await loadPuzzle();
      renderProfile();
    } }, "Sign out"));
  } else if (account.enabled) {
    parts.push(h("p", { class: "hint center" }, "These stats are saved on this device only."), authForm());
  }
  parts.push(teamPicker(), installPrompt());
  $("#profile-body").replaceChildren(...parts.filter(Boolean));
}

async function openProfile() {
  $("#profile").open || $("#profile").showModal();
  renderProfile();
  await refreshAccount();
  renderProfile();
}

// ---- Leaderboard ------------------------------------------------------------------------------------
let lbScope = null; // league id, or null for everyone

async function openLeaderboard(scope = lbScope) {
  lbScope = scope;
  const body = $("#leaderboard-body");
  body.replaceChildren(h("p", { class: "hint center" }, "Loading…"));
  if (!$("#leaderboard").open) $("#leaderboard").showModal();

  let leagues = [];
  if (signedIn()) {
    try {
      leagues = (await api("leagues")).leagues;
    } catch {
      /* leagues are optional */
    }
  }
  if (lbScope && !leagues.some((l) => l.id === lbScope)) lbScope = null;

  let data;
  try {
    data = await api(`leaderboard?date=${date}${lbScope ? `&league=${lbScope}` : ""}`);
  } catch (e) {
    body.replaceChildren(errorLine(e.message));
    return;
  }
  if (!data.enabled) {
    body.replaceChildren(h("p", { class: "hint center" }, "Leaderboards aren't switched on yet. Check back soon!"));
    return;
  }

  const scopes = leagues.length
    ? h("div", { class: "scopes" },
        [{ id: null, name: "Everyone" }, ...leagues].map((l) =>
          h("button", { type: "button", "aria-pressed": String(lbScope === l.id), onclick: () => openLeaderboard(l.id) }, l.name)))
    : null;

  let tab = "daily";
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const list = h("div", {});
  const draw = () => {
    tabs.replaceChildren(
      ...[["daily", `#${puzzle.number} · ${prettyDate(date, false)}`], ["allTime", "All time"]].map(([key, label]) =>
        h("button", { type: "button", role: "tab", "aria-selected": String(tab === key), onclick: () => { tab = key; draw(); } }, label)),
    );
    const board = data[tab];
    if (!board.top.length) {
      list.replaceChildren(h("p", { class: "hint center" }, tab === "daily" ? "No one has finished this puzzle on the day yet. Be the first!" : "No scores yet."));
    } else {
      const row = (r) => h("li", { class: r.me ? "me" : "" },
        h("span", { class: "rank" }, String(r.rank)),
        h("span", { class: "who" }, r.username),
        h("span", { class: "pts" }, tab === "daily" ? `${r.points} pts` : `${r.total.toLocaleString()} pts`),
        h("span", { class: "extra" }, tab === "daily"
          ? `${r.yards} yds in ${r.clock} plays`
          : `${r.games} drives · ${r.tds} TDs · avg ${r.avg_yards} yds`));
      const rows = board.top.map(row);
      if (board.me && !board.top.some((r) => r.me)) rows.push(h("li", { class: "gap" }, "…"), row(board.me));
      list.replaceChildren(h("ol", { class: "board" }, rows), h("p", { class: "hint center" }, `${board.count} player${board.count === 1 ? "" : "s"}`));
    }
  };
  draw();
  const parts = [scopes, tabs, list];
  if (signedIn()) parts.push(leaguePanel(leagues));
  else parts.push(h("p", { class: "cta" }, h("button", { type: "button", class: "link", onclick: () => { $("#leaderboard").close(); openProfile(); } }, "Create an account"), " to get on the board and start a league with friends."));
  body.replaceChildren(...parts.filter(Boolean));
}

// ---- Leagues -----------------------------------------------------------------------------------------
const inviteLink = (code) => `${location.origin}/?join=${code}`;

function leaguePanel(leagues) {
  const err = h("p", { class: "error", role: "alert" });
  const status = h("p", { class: "toast", role: "status" });
  const current = leagues.find((l) => l.id === lbScope);

  const invite = current
    ? h("div", { class: "invite" },
        h("p", {}, h("strong", {}, current.name), ` · ${current.members} member${current.members === 1 ? "" : "s"}`),
        h("p", {}, "Invite code: ", h("code", {}, current.code)),
        h("div", { class: "row-btns" },
          h("button", { type: "button", class: "btn", onclick: async () => {
            const text = `Join my Fourth & Daily league "${current.name}": ${inviteLink(current.code)}`;
            if (navigator.share && matchMedia("(pointer: coarse)").matches) {
              try { await navigator.share({ text }); return; } catch (e) { if (e.name === "AbortError") return; }
            }
            try { await navigator.clipboard.writeText(text); status.textContent = "Invite link copied!"; }
            catch { status.textContent = `Share this link: ${inviteLink(current.code)}`; }
          } }, "Invite friends"),
          h("button", { type: "button", class: "btn", onclick: async () => {
            if (!confirm(`Leave "${current.name}"?`)) return;
            await api("leagues", { action: "leave", id: current.id }).catch(() => {});
            openLeaderboard(null);
          } }, "Leave league")),
        status)
    : null;

  const nameInput = h("input", { placeholder: "League name", maxlength: 30, minlength: 3, required: true, "aria-label": "League name" });
  const create = h("form", { class: "inline-form" }, nameInput, h("button", { type: "submit", class: "btn primary" }, "Create"));
  create.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    try {
      const { league } = await api("leagues", { action: "create", name: nameInput.value });
      openLeaderboard(league.id);
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  const codeInput = h("input", { placeholder: "Invite code", maxlength: 6, required: true, autocapitalize: "characters", "aria-label": "Invite code" });
  const join = h("form", { class: "inline-form" }, codeInput, h("button", { type: "submit", class: "btn" }, "Join"));
  join.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    try {
      const { league } = await api("leagues", { action: "join", code: codeInput.value });
      openLeaderboard(league.id);
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  return h("section", { class: "leagues" },
    invite,
    h("h3", {}, "Leagues"),
    h("p", { class: "hint" }, "Compete with friends on a private leaderboard."),
    create, join, err);
}

/** Handle ?join=CODE invite links: join now, or after signing in. */
async function handleJoinLink() {
  let code = params.get("join");
  if (code) {
    history.replaceState(null, "", location.pathname + (date !== today ? `?date=${date}` : ""));
    try { sessionStorage.setItem("nfldaily:join", code); } catch { /* ignore */ }
  } else {
    try { code = sessionStorage.getItem("nfldaily:join"); } catch { code = null; }
  }
  if (!code || !account.enabled) return;
  if (!signedIn()) {
    let name = "a league";
    try { name = `"${(await api(`leagues?code=${encodeURIComponent(code)}`)).league.name}"`; } catch { /* unknown code */ }
    await openProfile();
    $("#profile-body").prepend(h("p", { class: "banner" }, `Sign in or create an account to join ${name}.`));
    return;
  }
  try { sessionStorage.removeItem("nfldaily:join"); } catch { /* ignore */ }
  try {
    const { league } = await api("leagues", { action: "join", code });
    if ($("#profile").open) $("#profile").close();
    await openLeaderboard(league.id);
  } catch (e) {
    alert(e.message);
  }
}

// ---- Archive ----------------------------------------------------------------------------------------
async function openArchive() {
  const body = $("#archive-body");
  body.replaceChildren(h("p", { class: "hint center" }, "Loading…"));
  $("#archive").showModal();
  let data;
  try {
    data = await api("archive");
  } catch (e) {
    body.replaceChildren(errorLine(e.message));
    return;
  }
  const items = data.dates.filter((d) => d.date <= today).map(({ date: d, number }) => {
    let status = "Play";
    let cls = "";
    const fmt = (pts, yds) => (pts ? `${pts} pts` : `${yds} yds`);
    if (data.mine) {
      const m = data.mine[d];
      if (m?.done) { status = fmt(m.points, m.yards); cls = "done"; }
      else if (m) status = "In progress";
    } else {
      const s = store.drives[d]?.state;
      if (s?.phase === "over") { const x = summary(s); status = fmt(x.points, x.yards); cls = "done"; }
      else if (s?.log?.length) status = "In progress";
    }
    return h("li", {}, h("a", { href: d === today ? "./" : `./?date=${d}`, class: d === date ? "current" : "" },
      h("span", { class: "num" }, `#${number}`),
      h("span", { class: "day" }, d === today ? "Today" : prettyDate(d)),
      h("span", { class: `status ${cls}` }, status)));
  });
  body.replaceChildren(h("ul", { class: "archive-list" }, items));
}

// ---- Add to home screen ---------------------------------------------------------------------------
let deferredInstall = null; // Chromium's beforeinstallprompt event, if offered
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  render();
});
window.addEventListener("appinstalled", () => {
  deferredInstall = null;
  render();
});

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** "Add to home screen" button, or iPhone instructions, or nothing if the browser can't install. */
function installPrompt() {
  if (isStandalone()) return null;
  const status = h("p", { class: "toast", role: "status" });
  const canInstall = typeof Navigator.prototype.install === "function" || deferredInstall;
  if (canInstall) {
    const btn = h("button", { type: "button", class: "btn install" }, "📲 Add to home screen");
    btn.addEventListener("click", async () => {
      if (btn.getAttribute("aria-disabled") === "true") return;
      btn.setAttribute("aria-disabled", "true");
      try {
        if (typeof Navigator.prototype.install === "function") {
          await navigator.install(); // must run inside the click handler
          status.textContent = "Installed! Find Fourth & Daily on your home screen.";
        } else {
          deferredInstall.prompt();
          const { outcome } = await deferredInstall.userChoice;
          if (outcome === "accepted") status.textContent = "Installed! Find Fourth & Daily on your home screen.";
          deferredInstall = null;
        }
      } catch (e) {
        if (e.name !== "AbortError") console.error(e);
      } finally {
        btn.removeAttribute("aria-disabled");
      }
    });
    return h("div", {}, btn, status);
  }
  if (isIOS()) {
    return h("p", { class: "install-ios" }, "📲 Play every day from your home screen: tap ",
      h("strong", {}, "Share"), " then ", h("strong", {}, "Add to Home Screen"), ".");
  }
  return null;
}

// ---- Dialogs ----------------------------------------------------------------------------------------
// Light-dismiss fallback where <dialog closedby> isn't supported yet.
if (!("closedBy" in HTMLDialogElement.prototype)) {
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    dialog.addEventListener("click", (e) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside = r.top <= e.clientY && e.clientY <= r.bottom && r.left <= e.clientX && e.clientX <= r.right;
      if (!inside) dialog.close();
    });
  }
}
$("#help-btn").addEventListener("click", () => $("#help").showModal());
$("#profile-btn").addEventListener("click", openProfile);
$("#leaderboard-btn").addEventListener("click", () => openLeaderboard());
$("#archive-btn").addEventListener("click", openArchive);

// Vercel Web Analytics (page views only, no cookies). Only on the real site;
// it does nothing until Analytics is enabled in the Vercel project.
if (!["localhost", "127.0.0.1"].includes(location.hostname)) {
  window.va = window.va || function (...args) { (window.vaq = window.vaq || []).push(args); };
  document.head.append(h("script", { src: "/_vercel/insights/script.js", defer: true }));
}

// ---- Boot ---------------------------------------------------------------------------------------------
async function boot() {
  $("#puzzle-meta").textContent = prettyDate(date);
  loadNames().catch(() => {});
  loadChallenge();
  applyTeams();
  setupMute();
  await refreshAccount();
  updateStreak();
  try {
    await loadPuzzle();
  } catch {
    $("#stage").replaceChildren(
      h("div", { class: "card empty" }, h("p", {}, `No puzzle for ${prettyDate(date)}. `), h("a", { href: "./" }, "Go to today's puzzle")),
    );
    return;
  }
  if (params.get("join")) return handleJoinLink();
  try {
    if (!localStorage.getItem("nfldaily:seen-help")) {
      localStorage.setItem("nfldaily:seen-help", "1");
      $("#help").showModal();
    }
  } catch {
    /* ignore */
  }
}

boot();
