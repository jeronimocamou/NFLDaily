import { startStadium } from "./stadium.js";
import { createFieldView } from "./fieldview.js";
import {
  RULES, CALLS, CALL_BLURB, CALL_LABEL, canKick, clockText, downText, driveRank, fgDistance, fieldSpot, newDrive,
  playsLeft, resolve, snap, summary, CODE_EMOJI,
} from "./drive.js";

// Fourth & Daily client. Each day is one drive: 2:00 left, down 21-17, ball
// on your own 25. Every question is a play. Signed-in players' drives run on
// the server (/api/drive), which times every play. Anonymous drives run in
// the browser with the same rules (site/drive.js); answers are graded by
// /api/answer and progress is kept in localStorage.

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
let puzzle = null; // anonymous: every round (no answers); signed in: { number, plays }
let drive = null; // engine state (site/drive.js)
let qdata = {}; // per question index: { done, score, guesses, attempts, hint, reveal, error }
let qcache = {}; // signed in: questions as they were served
let lastPlay = null; // { idx, event } for the result card
let liveStart = 0; // local time the live play was snapped
let busy = false;
let animating = false;
let showFinal = false;
let crowd = null;

const signedIn = () => Boolean(account.user);
const layout = () => puzzle.layout;
const roundAt = (i) => (puzzle.rounds ? puzzle.rounds[i] : qcache[i]);

const field = createFieldView($("#field"));
const stadium = startStadium($("#stadium"));

function persistLocal() {
  if (signedIn()) return;
  const d = (store.drives[date] = store.drives[date] || {});
  Object.assign(d, { state: drive, q: qdata, last: lastPlay });
  if (drive.phase === "over" && d.onTime == null) d.onTime = date === localISO();
  saveStore();
}

// ---- Scoreboard and clocks ---------------------------------------------------------------------
function elapsed() {
  return drive?.phase === "live" ? (Date.now() - liveStart) / 1000 : 0;
}

function updateHud() {
  if (!drive) return;
  $("#game-hud").hidden = false;
  const live = drive.phase === "live";
  const t = elapsed();
  const gameRuns = live && (drive.live.kind === "play" || drive.live.kind === "fg");
  $("#sb-us").textContent = String(RULES.us + drive.points);
  $("#sb-them").textContent = String(RULES.them);
  $("#sb-clock").textContent = clockText(gameRuns ? Math.max(0, drive.clock - t) : drive.clock);
  const kind = drive.live?.kind;
  $("#sb-down").textContent = drive.phase === "over" ? "FINAL"
    : drive.phase === "pat_choice" || kind === "pat1" || kind === "pat2" ? "TRY"
    : kind === "fg" ? `FG · ${fgDistance(drive)} YDS` : downText(drive);
  $("#sb-spot").textContent = drive.phase === "over" ? `${summary(drive).yards} YDS` : `BALL ${fieldSpot(drive.yl)}`;
  const pc = $("#sb-play");
  if (live) {
    const left = Math.max(0, RULES.playClock - t);
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

// ---- Rendering helpers ---------------------------------------------------------------------
function optionButton(opt, { onclick, note, disabled, cls, badge } = {}) {
  return h(
    "button",
    { type: "button", class: `team-btn ${cls || ""}`, style: { "--c1": opt.color, "--c2": opt.color2 }, disabled, onclick },
    h("span", { class: "name" }, opt.name),
    opt.sub ? h("span", { class: "sub" }, opt.sub) : null,
    note ? h("span", { class: "note" }, note) : null,
    badge,
  );
}

function callFor(i) {
  if (drive.phase === "live" && drive.live.round === i) return drive.live.kind;
  return drive.log.findLast?.((e) => e.round === i)?.kind || [...drive.log].reverse().find((e) => e.round === i)?.kind || roundAt(i)?.role;
}

function roundShell(round, i, ...body) {
  const call = callFor(i);
  const live = drive.phase === "live" && drive.live.round === i;
  const label = call === "fg" ? `Field goal · ${live ? fgDistance(drive) + " yds" : ""}` : `${CALL_LABEL[call] || "Play"} · ${live ? downText(drive) : `Play ${drive.log.findIndex((e) => e.round === i) + 1}`}`;
  return h(
    "article",
    { class: `card ${live ? "live" : ""}` },
    live ? h("div", { class: "playclock" }, h("div", { id: "playclock-bar" })) : null,
    h("div", { class: "round-label" }, h("span", {}, label), h("span", { class: "season-chip" }, String(round.season))),
    h("h2", { class: "prompt" }, round.prompt),
    round.hint ? h("p", { class: "hint" }, round.hint) : null,
    ...body,
  );
}

function crowdLine(i) {
  const c = crowd?.rounds?.[i];
  const round = roundAt(i);
  if (!c || !round) return null;
  const players = `${c.plays.toLocaleString()} player${c.plays === 1 ? "" : "s"}`;
  let text;
  if (c.plays === 1) text = "You're the first to run this play!";
  else if (round.type === "guess_number" || round.type === "rank_four") text = `Players averaged ${c.avg}/100 on this one · ${c.perfectPct}% nailed it (${players})`;
  else if (round.type === "who_am_i") text = `${c.perfectPct}% got it on the first try (${players})`;
  else if (round.type === "name_one") text = `${c.perfectPct}% of players named a right answer (${players})`;
  else text = `${c.perfectPct}% of players got this right (${players})`;
  return h("p", { class: "crowd" }, "👥 ", text);
}

const tierOf = (ev) => (ev.td || ev.good ? "good" : ev.yards >= 10 ? "good" : ev.yards > 0 ? "mid" : ev.yards === 0 && !ev.delay ? "low" : "bad");

function resultBox(score, line, fact, i) {
  const ev = lastPlay?.idx === i ? lastPlay.event : null;
  const tier = ev ? tierOf(ev) : score >= 100 ? "good" : score > 0 ? "mid" : "bad";
  const code = ev ? drive.log.find((e) => e.round === i)?.code : null;
  return h(
    "div",
    { class: "result", style: { "--tier": `var(--${tier})` } },
    h("div", { class: "pts" }, `${code ? CODE_EMOJI[code] : ""} ${ev ? ev.text : ""}`.trim()),
    line ? h("p", {}, line) : null,
    i != null ? crowdLine(i) : null,
    h("p", { class: "fact" }, fact),
  );
}

function errorLine(msg) {
  return h("p", { class: "error", role: "alert" }, msg);
}

/** Play-call buttons and other choices for what happens next. */
function driveButtons() {
  const dis = busy || animating;
  const btn = (label, onclick, primary = true) => h("button", { type: "button", class: `btn ${primary ? "primary" : ""}`, disabled: dis, onclick }, label);
  const callButtons = () => {
    const left = playsLeft(drive, layout());
    return h("div", { class: "calls" }, CALLS.map((c) =>
      h("button", { type: "button", class: `call call-${c}`, disabled: dis || !left[c], onclick: () => act(c) },
        h("span", { class: "call-name" }, CALL_LABEL[c]),
        h("span", { class: "call-blurb" }, CALL_BLURB[c]),
        h("span", { class: "call-left" }, left[c] ? `${left[c]} left` : "none left"))));
  };
  switch (drive.phase) {
    case "ready":
      return h("div", { class: "decide" }, h("p", { class: "hint" }, `${downText(drive)} at ${fieldSpot(drive.yl)}. Call the play:`), callButtons());
    case "decide": {
      const kick = canKick(drive) ? btn(`Kick a ${fgDistance(drive)}-yd field goal`, () => act("fg"), false) : null;
      return h("div", { class: "decide" },
        h("p", { class: "hint" }, drive.down === 4
          ? (kick ? `4th & ${drive.toGo}. A field goal only cuts it to 21-20 (it's a number guess: longer kicks need closer answers). Or go for it:` : `4th & ${drive.toGo}. Out of field goal range: go for it or the drive is over.`)
          : `${clockText(drive.clock)} left and you're in field goal range. Kick, or call a play:`),
        kick, callButtons());
    }
    case "pat_choice":
      return h("div", { class: "decide" },
        h("p", { class: "hint" }, "Touchdown! Kick the extra point (an easier question) or go for two (a harder one)?"),
        btn("Kick the extra point (+1)", () => act("pat1")),
        btn("Go for two (+2)", () => act("pat2"), false));
    case "over":
      return btn("See the final ▶", () => { showFinal = true; render(); });
  }
  return null;
}

// ---- Playing ----------------------------------------------------------------------------------
function applyServer(r) {
  if (r.now) liveStartFrom(r.state, r.now);
  drive = r.state;
  if (r.question) qcache[r.question.index] = r.question;
}

function liveStartFrom(state, serverNow) {
  if (state?.phase === "live") liveStart = Date.now() - (serverNow - state.live.servedAt);
}

async function act(kind) {
  if (busy || animating) return;
  busy = true;
  try {
    if (signedIn()) {
      applyServer(await api("drive", { date, action: kind }));
    } else {
      const next = snap(drive, kind, Date.now(), layout());
      if (!next) throw new Error("You can't do that right now.");
      drive = next;
      liveStart = drive.live.servedAt;
      persistLocal();
    }
    lastPlay = null;
    startTicker();
  } catch (e) {
    lastPlay = lastPlay && { ...lastPlay };
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
  const prev = qdata[i] || { attempts: 0, guesses: [] };
  try {
    if (signedIn()) {
      const r = await api("drive", { date, action: "answer", guess });
      if (r.event) {
        const entry = r.state.log.at(-1);
        await finishPlay(i, r.state, r.event, r.reveal, entry?.guesses || [], r.popular);
        return;
      }
      applyServer(r);
      qdata[i] = { done: false, attempts: r.state.live.attempts, guesses: r.state.live.guesses, hint: r.hint };
    } else if (guess == null) {
      const s = structuredClone(drive);
      const { state, event } = resolve(s, roundAt(i), null, RULES.playClock + 1, layout());
      await finishPlay(i, state, event, null, []);
      return;
    } else {
      const view = await api("answer", { date, round: i, guess, attempt: prev.attempts + 1 });
      const guesses = [...prev.guesses, guess];
      if (!view.done) {
        qdata[i] = { done: false, attempts: prev.attempts + 1, guesses, hint: view.hint };
        drive.live.attempts += 1;
        drive.live.guesses = guesses;
        persistLocal();
      } else {
        const secs = (Date.now() - liveStart) / 1000;
        const s = structuredClone(drive);
        s.live.guesses = guesses;
        const { state, event } = resolve(s, roundAt(i), view.result, secs, layout());
        await finishPlay(i, state, event, view.reveal, guesses, view.popular);
        return;
      }
    }
  } catch (e) {
    qdata[i] = { ...prev, error: e.message };
  } finally {
    busy = false;
    render();
  }
}

async function finishPlay(i, state, event, reveal, guesses, popular = null) {
  clearInterval(ticker);
  const before = drive;
  qdata[i] = { done: true, score: event.score, hit: event.hit, rarity: event.rarity, guesses, attempts: guesses.length, reveal, popular, timedOut: guesses.length === 0 };
  drive = state;
  lastPlay = { idx: i, event };
  persistLocal();
  busy = false;
  animating = true;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
  await field.animate(event, before, state);
  if (event.td || (event.kind === "fg" && event.good)) stadium.cheer();
  animating = false;
  if (drive.phase === "over") await onDriveOver();
  render();
  refreshCrowd();
}

async function onDriveOver() {
  if (signedIn()) {
    refreshAccount();
  } else if (account.enabled) {
    api("stats", { date, log: drive.log }).catch(() => {});
  }
}

// ---- Type-ahead answers ("name one" plays) -------------------------------------------------
let names = null;
const MIN_FOR_PCT = 5; // show "how often players named it" once enough people have answered
const normName = (x) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

async function loadNames() {
  if (names) return names;
  const data = await (await fetch("/names.json")).json();
  names = {
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

function answersList(round, st) {
  const pop = st.popular?.answers
    || (st.reveal ? Object.entries(st.reveal.valid).map(([id, v]) => ({ id, name: v.name, note: v.note, pct: 0, n: 0 })) : []);
  if (!pop.length) return null;
  const total = st.popular?.total >= MIN_FOR_PCT ? st.popular.total : 0;
  const row = (a) => h("li", { class: a.yours ? "yours" : "" },
    h("span", { class: "a-name" }, a.name),
    h("span", { class: "a-note" }, a.note || ""),
    total ? h("span", { class: "a-pct" }, `${a.pct}%`) : null,
    total ? h("span", { class: "a-bar", style: { "--w": `${a.pct}%` } }) : null);
  const top = pop.slice(0, 8);
  const rest = pop.slice(8);
  return h("div", { class: "answers" },
    h("p", { class: "hint" }, pop.length === 1 ? "The answer" : total ? `All ${pop.length} right answers, by how often players named them` : `All ${pop.length} right answers`),
    h("ol", {}, top.map(row)),
    rest.length ? h("details", {}, h("summary", {}, `Show ${rest.length} more`), h("ol", { start: 9 }, rest.map(row))) : null);
}

function renderNameOne(round, i) {
  const st = qdata[i] || {};
  const done = st.done;
  const body = [];
  if (round.clues) body.push(h("ul", { class: "clues" }, round.clues.map((c) => h("li", {}, c))));
  if (!done) {
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
    const submit = h("button", { type: "button", class: "btn primary", disabled: true }, drive.live?.kind === "deep" ? "Let it fly ▶" : "Throw it ▶");
    const choose = (n) => {
      picked = n;
      input.value = n.name;
      results = [];
      draw();
      submit.disabled = false;
    };
    const draw = () => {
      list.replaceChildren(...results.map((n, k) => h("li", {
        role: "option", id: `${listId}-${k}`, class: k === active ? "active" : "", "aria-selected": String(k === active),
        onmousedown: (e) => { e.preventDefault(); choose(n); },
      }, h("span", { class: "n" }, n.name), n.sub ? h("span", { class: "s" }, n.sub) : null)));
      input.setAttribute("aria-expanded", String(results.length > 0));
      if (results.length) input.setAttribute("aria-activedescendant", `${listId}-${active}`);
      else input.removeAttribute("aria-activedescendant");
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
    const guess = st.guesses?.at(-1);
    const yours = guess ? (st.popular?.answers.find((a) => a.id === guess)?.name || nameFor(round.answer_kind, guess) || "Your answer") : null;
    let line;
    if (st.timedOut) line = "The play clock ran out.";
    else if (st.hit) {
      const mine = st.popular?.answers.find((a) => a.yours);
      line = `${yours} is right!`;
      if (st.popular?.total >= MIN_FOR_PCT && mine) line += ` ${mine.pct}% of players said that.`;
      if (st.rarity >= 0.6) line += " A rare pull!";
      else if (st.rarity <= 0.15) line += " A popular pick.";
    } else line = `${yours} isn't one of the right answers.`;
    body.push(resultBox(st.score, line, st.reveal?.fact, i), driveButtons(), answersList(round, st));
  }
  return roundShell(round, i, ...body);
}

// ---- Question cards --------------------------------------------------------------------------
function answerLine(round, st, okText) {
  if (st.timedOut) return "The play clock ran out.";
  return okText;
}

function renderChoice(round, i) {
  const st = qdata[i] || {};
  const done = st.done;
  const rv = st.reveal;
  const pick = st.guesses?.at(-1);
  const opts = round.options.map((o, idx) => {
    let cls = "";
    if (done && rv) cls = idx === rv.answer ? "correct" : idx === pick ? "wrong" : "dim";
    return optionButton(o, { cls, note: done && rv ? rv.notes[idx] : null, disabled: done, onclick: () => answer(i, idx) });
  });
  const body = [h("div", { class: `options ${round.options.length === 2 ? "two" : ""}` }, opts)];
  if (st.error) body.push(errorLine(st.error));
  if (done) {
    const ok = rv && pick === rv.answer;
    body.push(resultBox(st.score, answerLine(round, st, ok ? "Correct!" : rv ? `The answer was ${round.options[rv.answer].name}.` : ""), rv?.fact, i), driveButtons());
  }
  return roundShell(round, i, ...body);
}

function renderWho(round, i) {
  const st = qdata[i] || { attempts: 0, guesses: [] };
  const done = st.done;
  const rv = st.reveal;
  const wrong = new Set(done ? [] : st.guesses || []);
  const clues = h("ul", { class: "clues" }, round.clues.map((c) => h("li", {}, c)));
  const opts = round.options.map((o, idx) => {
    let cls = "plain";
    if (done && rv) cls += idx === rv.answer ? " correct" : (st.guesses || []).includes(idx) ? " wrong" : " dim";
    else if (wrong.has(idx)) cls += " wrong";
    return optionButton(o, { cls, note: done && rv ? rv.notes[idx] : null, disabled: done || wrong.has(idx), onclick: () => answer(i, idx) });
  });
  const body = [clues, h("div", { class: "options" }, opts)];
  if (st.error) body.push(errorLine(st.error));
  if (!done && st.hint) body.splice(1, 0, h("p", { class: "hint-box" }, h("strong", {}, "Not quite. Hint: "), st.hint, " One more try: hurry!"));
  if (done) {
    const got = rv && (st.guesses || []).at(-1) === rv.answer;
    const line = got ? (st.attempts === 1 ? "Got it on the first try!" : "Got it on the second try.") : rv ? `It was ${round.options[rv.answer].name}.` : "";
    body.push(resultBox(st.score, answerLine(round, st, line), rv?.fact, i), driveButtons());
  }
  return roundShell(round, i, ...body);
}

function renderNumber(round, i) {
  const st = qdata[i] || {};
  const done = st.done;
  const step = round.step || 1;
  let value = done && st.guesses?.length ? st.guesses.at(-1) : round.start;
  const display = h("div", { class: "number-display", "aria-live": "polite" }, value.toLocaleString());
  const slider = h("input", { type: "range", min: round.min, max: round.max, step, value, disabled: done, "aria-label": "Your guess" });
  const set = (v) => {
    value = Math.min(round.max, Math.max(round.min, Math.round(v / step) * step));
    slider.value = value;
    display.textContent = value.toLocaleString();
  };
  slider.addEventListener("input", () => set(Number(slider.value)));
  const bump = round.bump || 1;
  const body = [
    round.subject ? h("div", { class: "subject", style: { "--c1": round.subject.color, "--c2": round.subject.color2 } },
      h("span", { class: "name" }, round.subject.name), round.subject.sub ? h("span", { class: "sub" }, round.subject.sub) : null) : null,
    h("div", { class: "number-input" },
      h("div", { class: "stepper" },
        h("button", { type: "button", "aria-label": `Minus ${bump}`, disabled: done, onclick: () => set(value - bump) }, "−"),
        display,
        h("button", { type: "button", "aria-label": `Plus ${bump}`, disabled: done, onclick: () => set(value + bump) }, "+")),
      slider,
      h("div", { class: "range-ends" }, h("span", {}, round.min.toLocaleString()), h("span", {}, round.max.toLocaleString()))),
  ];
  if (st.error) body.push(errorLine(st.error));
  if (done) {
    const rv = st.reveal;
    let line = "";
    if (rv && st.guesses?.length) {
      const diff = Math.abs(st.guesses.at(-1) - rv.answer);
      line = diff === 0 ? `Exactly right: ${rv.answer_label}.` : `Answer: ${rv.answer_label}. You were ${diff.toLocaleString()} off.`;
    }
    body.push(resultBox(st.score, answerLine(round, st, line), rv?.fact, i), driveButtons());
  } else {
    body.push(h("button", { type: "button", class: "btn primary", onclick: () => answer(i, value) }, "Lock it in"));
  }
  return roundShell(round, i, ...body);
}

const rankDraft = {};
function renderRank(round, i) {
  const st = qdata[i] || {};
  const done = st.done;
  const order = done ? st.guesses?.at(-1) || [] : (rankDraft[i] ||= []);
  const card = roundShell(round, i);
  const list = h("div", { class: "options rank" });
  const submit = h("button", { type: "button", class: "btn primary", disabled: true }, "Lock it in");
  const draw = () => {
    if (done && st.reveal) {
      const rv = st.reveal;
      list.replaceChildren(...rv.answer.map((optIdx, pos) => {
        const ok = order[pos] === optIdx;
        const yours = order.indexOf(optIdx) + 1;
        return optionButton(round.options[optIdx], {
          disabled: true, cls: ok ? "correct" : "wrong",
          note: `${rv.notes[optIdx]}${ok || !yours ? "" : ` · you had #${yours}`}`,
          badge: h("span", { class: `badge ${ok ? "ok" : "no"}` }, String(pos + 1)),
        });
      }));
      return;
    }
    list.replaceChildren(...round.options.map((o, idx) => {
      const pos = order.indexOf(idx);
      return optionButton(o, {
        disabled: done,
        onclick: () => {
          if (pos >= 0) order.splice(pos, 1);
          else order.push(idx);
          draw();
        },
        badge: pos >= 0 ? h("span", { class: "badge" }, String(pos + 1)) : null,
      });
    }));
    submit.disabled = order.length !== round.options.length;
  };
  submit.addEventListener("click", () => answer(i, [...order]));
  draw();
  card.append(h("p", { class: "hint" }, done ? "Correct order:" : "Tap from best to worst. Tap again to undo."), list);
  if (st.error) card.append(errorLine(st.error));
  if (done) card.append(resultBox(st.score, answerLine(round, st, `You placed ${Math.round(st.score / 25)} of 4 correctly.`), st.reveal?.fact, i), driveButtons());
  else card.append(submit);
  return card;
}

function questionCard(i) {
  const round = roundAt(i);
  if (!round) return null;
  const card = round.type === "name_one" ? renderNameOne(round, i)
    : round.type === "guess_number" ? renderNumber(round, i)
    : round.type === "rank_four" ? renderRank(round, i)
    : round.type === "who_am_i" ? renderWho(round, i)
    : renderChoice(round, i);
  // After the play, lead with what happened and what's next; the answers follow.
  const result = card.querySelector(".result");
  if (result) {
    const next = result.nextElementSibling;
    const anchor = card.querySelector(".prompt + .hint") || card.querySelector(".prompt");
    anchor.after(result);
    if (next) result.after(next);
  }
  return card;
}

/** Shown before the first snap, or when coming back mid-drive. */
function huddleCard() {
  const intro = drive.log.length === 0;
  return h("article", { class: "card huddle" },
    h("div", { class: "round-label" }, h("span", {}, intro ? "The situation" : "Huddle"), h("span", { class: "season-chip" }, `#${puzzle.number}`)),
    intro
      ? h("div", {},
          h("h2", { class: "prompt" }, "2:00 left. Down 21-17. Your ball on the 25."),
          h("p", {}, "You call every play. RUN: guess a number, closer gains more. PASS: name one right answer, rarer answers gain more. DEEP SHOT: name one of a few for a big gain, but a miss is a sack. 25 seconds per play, and the clock runs while you think."),
          h("p", {}, "Score a touchdown to win it. You can kick a field goal, but that still loses by one."))
      : h("h2", { class: "prompt" }, `${downText(drive)} at ${fieldSpot(drive.yl)}, ${clockText(drive.clock)} left.`),
    driveButtons());
}

// ---- The final ----------------------------------------------------------------------------------
function renderSummary() {
  const sum = summary(drive);
  const us = RULES.us + sum.points;
  const grid = sum.codes.split("").map((c) => CODE_EMOJI[c]).join("");
  const toast = h("p", { class: "toast", role: "status" });
  const code = `${puzzle.number}-${sum.points}-${sum.yards}-${sum.clock}-${sum.codes || "w"}`;
  const shareText = `Fourth & Daily #${puzzle.number} 🏈 ${sum.label}\n${sum.points} pts · ${sum.yards} yds · ${clockText(sum.clock)} left\n${grid}\n${location.origin}/s/${code}`;

  const share = async () => {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
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

  let crowdText = null;
  if (crowd?.players > 1 && crowd.beat != null) {
    crowdText = `Better than ${crowd.beat}% of ${crowd.players.toLocaleString()} drives today · ${crowd.tdPct}% scored a TD`;
  } else if (crowd?.players === 1) {
    crowdText = "You're the first to finish this drive!";
  }
  const cta = account.enabled && !signedIn()
    ? h("p", { class: "cta" }, "Want to be on the leaderboard? ", h("button", { type: "button", class: "link", onclick: openProfile }, "Create a free account"), " before tomorrow's drive.")
    : null;

  const plays = drive.log.map((e) => {
    const round = roundAt(e.round);
    const what = e.kind === "pat1" || e.kind === "pat2" ? CALL_LABEL[e.kind] : `${CALL_LABEL[e.kind] || "Play"} (${round?.season ?? ""})`;
    const yds = CALLS.includes(e.kind) ? `${e.yards > 0 ? "+" : ""}${e.yards} yds` : e.code === "k" || e.code === "p" ? "Good" : "No good";
    return h("li", {}, h("span", {}, `${CODE_EMOJI[e.code]} ${what}`), h("span", { class: "score" }, yds));
  });

  return h("article", { class: "card summary" },
    h("div", { class: "round-label" }, h("span", {}, `Drive #${puzzle.number}`), h("span", {}, prettyDate(date))),
    h("p", { class: "big" }, sum.label),
    h("p", { class: "final-score" }, `YOU ${us} – ${RULES.them} THEM`),
    h("p", { class: "out-of" }, `${sum.won ? "You win! " : "Final. "}${sum.why}`),
    h("p", { class: "drive-line" }, `${sum.points} pts · ${sum.yards} yds · ${clockText(sum.clock)} left`),
    h("div", { class: "grid", "aria-label": "Drive chart" }, grid),
    crowdText ? h("p", { class: "crowd center" }, "👥 ", crowdText) : null,
    h("button", { type: "button", class: "btn primary", onclick: share }, "Share your drive"),
    toast,
    cta,
    h("ol", { class: "summary-list" }, plays),
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
  const stage = $("#stage");
  let card;
  if (drive.phase === "over" && (showFinal || !lastPlay)) card = renderSummary();
  else if (drive.phase === "live") card = questionCard(drive.live.round);
  else if (lastPlay && roundAt(lastPlay.idx)) card = questionCard(lastPlay.idx);
  else card = huddleCard();
  stage.replaceChildren(card || huddleCard());
}

function renderBanner() {
  const banner = $("#banner");
  if (date === today) return banner.replaceChildren();
  banner.replaceChildren(
    h("p", { class: "banner" }, `Archive drive from ${prettyDate(date)}. It won't count toward streaks or leaderboards. `,
      h("a", { href: "./" }, "Play today's →")),
  );
}

async function refreshCrowd() {
  if (!account.enabled || !puzzle || !drive) return;
  const scoreParam = drive.phase === "over" ? `&score=${driveRank(summary(drive))}` : "";
  try {
    const data = await api(`stats?date=${date}${scoreParam}`);
    if (data.enabled) {
      crowd = data;
      if (!animating) render();
    }
  } catch {
    /* stats are a nice-to-have */
  }
}

async function loadPuzzle() {
  const data = await api(`puzzle?date=${date}`);
  puzzle = data.puzzle;
  qdata = {};
  qcache = {};
  lastPlay = null;
  showFinal = false;
  if (data.user) {
    account.user = data.user;
    const r = await api(`drive?date=${date}`);
    applyServer(r);
    // Rebuild what we know about earlier plays from the drive log.
    for (const e of drive.log) qdata[e.round] = { done: true, score: e.score, guesses: e.guesses || [], attempts: (e.guesses || []).length };
    if (drive.phase === "live") {
      liveStartFrom(drive, r.now);
      const live = drive.live;
      if (live.attempts) qdata[live.round] = { done: false, attempts: live.attempts, guesses: live.guesses, hint: r.question?.hint };
    }
  } else {
    let saved = store.drives[date];
    // Drives saved before play calls existed start over (finished ones are kept).
    if (saved?.state && !saved.state.used && saved.state.phase !== "over") saved = null;
    drive = saved?.state || newDrive();
    qdata = saved?.q || {};
    lastPlay = saved?.last || null;
    if (drive.phase === "live") liveStart = drive.live.servedAt;
  }
  showFinal = drive.phase === "over"; // coming back to a finished drive: straight to the final
  $("#puzzle-meta").textContent = `#${puzzle.number} · ${prettyDate(date)}`;
  crowd = null;
  renderBanner();
  render();
  if (drive.phase === "live") startTicker();
  refreshCrowd();
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
    bestDrive: top ? { points: top.points, yards: top.yards, clock: top.clock } : null,
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
      ? `Average drive: ${s.avgYards} yds · Best: ${b.points} pts, ${b.yards} yds, ${clockText(b.clock)} left`
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
  parts.push(installPrompt());
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
          ? `${r.yards} yds · ${clockText(r.clock)} left`
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
  await refreshAccount();
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
