import { startStadium } from "./stadium.js";

// NFL Daily client. Puzzles come from /api/puzzle without answers; every
// guess is graded by /api/answer. Signed-in players' progress lives on the
// server; anonymous progress lives in localStorage.

const STORE_KEY = "nfldaily:v2";
const ROUNDS = 5;
const TYPE_LABEL = {
  head_to_head: "Head to head",
  odd_one_out: "Odd one out",
  guess_number: "Guess the number",
  rank_four: "Rank four",
  who_am_i: "Who am I?",
};
const EMOJI = { good: "🟩", mid: "🟨", low: "🟧", bad: "🟥" };

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
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    return s && s.games ? s : { games: {} };
  } catch {
    return { games: {} };
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

// ---- Scoring helpers -------------------------------------------------------------------
function tier(score) {
  if (score >= 100) return "good";
  if (score >= 50) return "mid";
  if (score > 0) return "low";
  return "bad";
}
const total = (rounds) => rounds.reduce((s, r) => s + (r?.score || 0), 0);
const isComplete = (rounds) => rounds.length === ROUNDS && rounds.every((r) => r?.done);

// ---- App state ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const today = localISO();
let date = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") || "") ? params.get("date") : today;
if (date > today) date = today;

let store = loadStore();
let account = { enabled: false, user: null, stats: null };
let puzzle = null;
let rounds = []; // per-round state: { done, score, attempts, guesses, hint, reveal }
let current = 0;
let busy = false;

const signedIn = () => Boolean(account.user);

function persistLocal() {
  if (signedIn()) return;
  const g = (store.games[date] = store.games[date] || {});
  g.rounds = rounds;
  if (isComplete(rounds) && !g.completed) {
    g.completed = true;
    g.total = total(rounds);
    g.onTime = date === localISO();
  }
  saveStore();
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

function renderProgress() {
  $("#progress").replaceChildren(
    ...Array.from({ length: ROUNDS }, (_, i) => {
      const li = h("li", { "aria-label": `Round ${i + 1}` });
      const r = rounds[i];
      if (r?.done) li.dataset.tier = tier(r.score);
      else if (i === current) li.classList.add("current");
      return li;
    }),
  );
}

function roundShell(round, i, ...body) {
  return h(
    "article",
    { class: "card" },
    h(
      "div",
      { class: "round-label" },
      h("span", {}, `Round ${i + 1} · ${TYPE_LABEL[round.type]}`),
      h("span", { class: "season-chip" }, String(round.season)),
    ),
    h("h2", { class: "prompt" }, round.prompt),
    round.hint ? h("p", { class: "hint" }, round.hint) : null,
    ...body,
  );
}

function resultBox(score, line, fact) {
  return h(
    "div",
    { class: "result", style: { "--tier": `var(--${tier(score)})` } },
    h("div", { class: "pts" }, `${EMOJI[tier(score)]} +${score} points`),
    line ? h("p", {}, line) : null,
    h("p", { class: "fact" }, fact),
  );
}

function nextButton(i) {
  const last = i === ROUNDS - 1;
  return h(
    "button",
    { type: "button", class: "btn primary", onclick: () => { current = i + 1; render(); } },
    last ? "See results" : "Next round →",
  );
}

function errorLine(msg) {
  return h("p", { class: "error", role: "alert" }, msg);
}

// ---- Answering ------------------------------------------------------------------------------
async function answer(i, guess) {
  if (busy || rounds[i]?.done) return;
  busy = true;
  const prev = rounds[i] || { attempts: 0, guesses: [] };
  try {
    const view = await api("answer", { date, round: i, guess, attempt: prev.attempts + 1 });
    // Anonymous responses only know about this guess; keep local history.
    if (!signedIn()) view.guesses = [...(prev.guesses || []), guess];
    rounds[i] = view;
    persistLocal();
    if (isComplete(rounds) && signedIn()) refreshAccount();
  } catch (e) {
    rounds[i] = { ...prev, error: e.message };
  } finally {
    busy = false;
    render();
  }
}

// ---- Round renderers ------------------------------------------------------------------------

function renderChoice(round, i) {
  const st = rounds[i];
  const done = st?.done;
  const rv = st?.reveal;
  const pick = st?.guesses?.at(-1);
  const opts = round.options.map((o, idx) => {
    let cls = "";
    if (done) cls = idx === rv.answer ? "correct" : idx === pick ? "wrong" : "dim";
    return optionButton(o, { cls, note: done ? rv.notes[idx] : null, disabled: done, onclick: () => answer(i, idx) });
  });
  const body = [h("div", { class: `options ${round.options.length === 2 ? "two" : ""}` }, opts)];
  if (st?.error) body.push(errorLine(st.error));
  if (done) {
    const ok = pick === rv.answer;
    body.push(resultBox(st.score, ok ? "Correct!" : `The answer was ${round.options[rv.answer].name}.`, rv.fact), nextButton(i));
  }
  return roundShell(round, i, ...body);
}

function renderWho(round, i) {
  const st = rounds[i] || { attempts: 0, guesses: [] };
  const done = st.done;
  const rv = st.reveal;
  const wrong = new Set(done ? [] : st.guesses || []);
  const clues = h("ul", { class: "clues" }, round.clues.map((c) => h("li", {}, c)));
  const opts = round.options.map((o, idx) => {
    let cls = "plain";
    if (done) cls += idx === rv.answer ? " correct" : (st.guesses || []).includes(idx) ? " wrong" : " dim";
    else if (wrong.has(idx)) cls += " wrong";
    return optionButton(o, {
      cls,
      note: done ? rv.notes[idx] : null,
      disabled: done || wrong.has(idx),
      onclick: () => answer(i, idx),
    });
  });
  const body = [clues, h("div", { class: "options" }, opts)];
  if (st.error) body.push(errorLine(st.error));
  if (!done && st.hint) {
    body.splice(1, 0, h("p", { class: "hint-box" }, h("strong", {}, "Not quite. Hint: "), st.hint, " One more try for 50 points."));
  }
  if (done) {
    const got = (st.guesses || []).at(-1) === rv.answer;
    const line = got ? (st.attempts === 1 ? "Got it on the first try!" : "Got it on the second try.") : `It was ${round.options[rv.answer].name}.`;
    body.push(resultBox(st.score, line, rv.fact), nextButton(i));
  }
  return roundShell(round, i, ...body);
}

function renderNumber(round, i) {
  const st = rounds[i];
  const done = st?.done;
  const step = round.step || 1;
  let value = done ? st.guesses.at(-1) : round.start;
  const display = h("div", { class: "number-display", "aria-live": "polite" }, value.toLocaleString());
  const slider = h("input", {
    type: "range", min: round.min, max: round.max, step, value, disabled: done,
    "aria-label": "Your guess",
  });
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
    h(
      "div",
      { class: "number-input" },
      h(
        "div",
        { class: "stepper" },
        h("button", { type: "button", "aria-label": `Minus ${bump}`, disabled: done, onclick: () => set(value - bump) }, "−"),
        display,
        h("button", { type: "button", "aria-label": `Plus ${bump}`, disabled: done, onclick: () => set(value + bump) }, "+"),
      ),
      slider,
      h("div", { class: "range-ends" }, h("span", {}, round.min.toLocaleString()), h("span", {}, round.max.toLocaleString())),
    ),
  ];
  if (st?.error) body.push(errorLine(st.error));
  if (done) {
    const diff = Math.abs(st.guesses.at(-1) - st.reveal.answer);
    const line = diff === 0 ? `Exactly right: ${st.reveal.answer_label}.` : `Answer: ${st.reveal.answer_label}. You were ${diff.toLocaleString()} off.`;
    body.push(resultBox(st.score, line, st.reveal.fact), nextButton(i));
  } else {
    body.push(h("button", { type: "button", class: "btn primary", onclick: () => answer(i, value) }, "Lock it in"));
  }
  return roundShell(round, i, ...body);
}

function renderRank(round, i) {
  const st = rounds[i];
  const done = st?.done;
  const order = done ? st.guesses.at(-1) : (renderRank.draft[i] ||= []);
  const card = roundShell(round, i);
  const list = h("div", { class: "options rank" });
  const submit = h("button", { type: "button", class: "btn primary", disabled: true }, "Lock it in");

  const draw = () => {
    if (done) {
      const rv = st.reveal;
      list.replaceChildren(
        ...rv.answer.map((optIdx, pos) => {
          const ok = order[pos] === optIdx;
          const yours = order.indexOf(optIdx) + 1;
          return optionButton(round.options[optIdx], {
            disabled: true,
            cls: ok ? "correct" : "wrong",
            note: `${rv.notes[optIdx]}${ok ? "" : ` · you had #${yours}`}`,
            badge: h("span", { class: `badge ${ok ? "ok" : "no"}` }, String(pos + 1)),
          });
        }),
      );
      return;
    }
    list.replaceChildren(
      ...round.options.map((o, idx) => {
        const pos = order.indexOf(idx);
        return optionButton(o, {
          onclick: () => {
            if (pos >= 0) order.splice(pos, 1);
            else order.push(idx);
            draw();
          },
          badge: pos >= 0 ? h("span", { class: "badge" }, String(pos + 1)) : null,
        });
      }),
    );
    submit.disabled = order.length !== round.options.length;
  };
  submit.addEventListener("click", () => answer(i, [...order]));
  draw();

  card.append(h("p", { class: "hint" }, done ? "Correct order:" : "Tap from best to worst. Tap again to undo."), list);
  if (st?.error) card.append(errorLine(st.error));
  if (done) {
    const n = Math.round(st.score / 25);
    card.append(resultBox(st.score, `You placed ${n} of 4 correctly.`, st.reveal.fact), nextButton(i));
  } else {
    card.append(submit);
  }
  return card;
}
renderRank.draft = {};

function renderSummary() {
  const sum = total(rounds);
  const grid = rounds.map((r) => EMOJI[tier(r.score)]).join("");
  const toast = h("p", { class: "toast", role: "status" });
  const code = `${puzzle.number}-${sum}-${rounds.map((r) => tier(r.score)[0]).join("")}`;
  const shareText = `NFL Daily #${puzzle.number}: ${sum}/500\n${grid}\n${location.origin}/s/${code}`;

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
    nextIn.textContent = `Next puzzle in ${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  };
  tick();
  clearInterval(renderSummary.timer);
  renderSummary.timer = setInterval(tick, 1000);

  const cta = account.enabled && !signedIn()
    ? h("p", { class: "cta" }, "Want to be on the leaderboard? ", h("button", { type: "button", class: "link", onclick: openProfile }, "Create a free account"), " before tomorrow's puzzle.")
    : null;

  return h(
    "article",
    { class: "card summary" },
    h("div", { class: "round-label" }, h("span", {}, `Puzzle #${puzzle.number}`), h("span", {}, prettyDate(puzzle.date))),
    h("p", { class: "big" }, String(sum)),
    h("p", { class: "out-of" }, "out of 500"),
    h("div", { class: "grid", "aria-label": "Result grid" }, grid),
    h("button", { type: "button", class: "btn primary", onclick: share }, "Share result"),
    toast,
    cta,
    h(
      "ol",
      { class: "summary-list" },
      puzzle.rounds.map((r, i) =>
        h("li", {},
          h("span", {}, `${EMOJI[tier(rounds[i].score)]} ${r.season} · ${TYPE_LABEL[r.type]}`),
          h("span", { class: "score" }, `${rounds[i].score} pts`)),
      ),
    ),
    h("div", { class: "row-btns" },
      h("button", { type: "button", class: "btn", onclick: openLeaderboard }, "Leaderboard"),
      h("button", { type: "button", class: "btn", onclick: openArchive }, "Past puzzles")),
    date === today ? nextIn : null,
  );
}

// ---- Flow ---------------------------------------------------------------------------------------
function render() {
  renderProgress();
  const stage = $("#stage");
  if (current >= ROUNDS) {
    stage.replaceChildren(renderSummary());
    return;
  }
  const round = puzzle.rounds[current];
  const card =
    round.type === "guess_number" ? renderNumber(round, current)
    : round.type === "rank_four" ? renderRank(round, current)
    : round.type === "who_am_i" ? renderWho(round, current)
    : renderChoice(round, current);
  stage.replaceChildren(card);
}

function renderBanner() {
  const banner = $("#banner");
  if (date === today) return banner.replaceChildren();
  banner.replaceChildren(
    h("p", { class: "banner" }, `Archive puzzle from ${prettyDate(date)}. It won't count toward streaks or leaderboards. `,
      h("a", { href: "./" }, "Play today's →")),
  );
}

async function loadPuzzle() {
  const data = await api(`puzzle?date=${date}`);
  puzzle = data.puzzle;
  if (data.user) {
    account.user = data.user;
    rounds = data.progress.map((p) => p || null);
  } else {
    rounds = store.games[date]?.rounds?.map((r) => r || null) || [];
  }
  while (rounds.length < ROUNDS) rounds.push(null);
  current = rounds.findIndex((r) => !r?.done);
  if (current === -1) current = ROUNDS;
  $("#puzzle-meta").textContent = `#${puzzle.number} · ${prettyDate(date)}`;
  renderBanner();
  render();
}

// ---- Stats & account ------------------------------------------------------------------------------
function localStats() {
  const done = Object.entries(store.games).filter(([, g]) => g.completed);
  const totals = done.map(([, g]) => g.total);
  const onTime = new Set(done.filter(([, g]) => g.onTime).map(([d]) => d));
  let streak = 0;
  for (let d = onTime.has(today) ? today : addDays(today, -1); onTime.has(d); d = addDays(d, -1)) streak++;
  let best = 0;
  for (const d of onTime) {
    if (onTime.has(addDays(d, -1))) continue;
    let run = 0;
    for (let x = d; onTime.has(x); x = addDays(x, 1)) run++;
    best = Math.max(best, run);
  }
  return {
    played: done.length,
    avg: totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0,
    high: totals.length ? Math.max(...totals) : 0,
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

function localGamesForImport() {
  const games = {};
  for (const [d, g] of Object.entries(store.games)) {
    if (g.rounds) games[d] = { rounds: g.rounds.map((r) => ({ guesses: r?.guesses || [] })) };
  }
  return games;
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
    h("p", { class: "hint" }, "Save your stats across devices and get on the leaderboard. Just a username, no email needed."),
    h("label", {}, h("span", {}, "Username"), user),
    h("label", {}, h("span", {}, "Password"), pass),
    err, submit, toggle);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    err.textContent = "";
    try {
      await api("account", { action: mode, username: user.value.trim(), password: pass.value, games: localGamesForImport() });
      await refreshAccount();
      await loadPuzzle();
      renderProfile();
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
  const parts = [
    h("div", { class: "stat-row" }, stat(s.played, "Played"), stat(s.avg, "Avg score"), stat(s.streak, "Streak"), stat(s.best, "Best streak")),
    h("p", { class: "hint center" }, `High score: ${s.high} / 500`),
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
  $("#profile-body").replaceChildren(...parts);
}

async function openProfile() {
  $("#profile").open || $("#profile").showModal();
  renderProfile();
  await refreshAccount();
  renderProfile();
}

// ---- Leaderboard ------------------------------------------------------------------------------------
async function openLeaderboard() {
  const body = $("#leaderboard-body");
  body.replaceChildren(h("p", { class: "hint center" }, "Loading…"));
  $("#leaderboard").showModal();
  let data;
  try {
    data = await api(`leaderboard?date=${date}`);
  } catch (e) {
    body.replaceChildren(errorLine(e.message));
    return;
  }
  if (!data.enabled) {
    body.replaceChildren(h("p", { class: "hint center" }, "Leaderboards aren't switched on yet. Check back soon!"));
    return;
  }
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
        h("span", { class: "pts" }, tab === "daily" ? String(r.total) : `${r.total.toLocaleString()}`),
        tab === "allTime" ? h("span", { class: "extra" }, `${r.games} games · avg ${r.avg}`) : null);
      const rows = board.top.map(row);
      if (board.me && !board.top.some((r) => r.me)) rows.push(h("li", { class: "gap" }, "…"), row(board.me));
      list.replaceChildren(h("ol", { class: "board" }, rows), h("p", { class: "hint center" }, `${board.count} player${board.count === 1 ? "" : "s"}`));
    }
    if (!signedIn()) list.append(h("p", { class: "cta" }, h("button", { type: "button", class: "link", onclick: () => { $("#leaderboard").close(); openProfile(); } }, "Create an account"), " to get on the board."));
  };
  draw();
  body.replaceChildren(tabs, list);
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
    if (data.mine) {
      const m = data.mine[d];
      if (m?.done === ROUNDS) { status = `${m.total}`; cls = "done"; }
      else if (m) status = "In progress";
    } else {
      const g = store.games[d];
      if (g?.completed) { status = `${g.total}`; cls = "done"; }
      else if (g?.rounds?.some((r) => r?.done)) status = "In progress";
    }
    return h("li", {}, h("a", { href: d === today ? "./" : `./?date=${d}`, class: d === date ? "current" : "" },
      h("span", { class: "num" }, `#${number}`),
      h("span", { class: "day" }, d === today ? "Today" : prettyDate(d)),
      h("span", { class: `status ${cls}` }, status)));
  });
  body.replaceChildren(h("ul", { class: "archive-list" }, items));
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
$("#leaderboard-btn").addEventListener("click", openLeaderboard);
$("#archive-btn").addEventListener("click", openArchive);

startStadium($("#stadium"));

// ---- Boot ---------------------------------------------------------------------------------------------
async function boot() {
  $("#puzzle-meta").textContent = prettyDate(date);
  await refreshAccount();
  try {
    await loadPuzzle();
  } catch {
    $("#stage").replaceChildren(
      h("div", { class: "card empty" }, h("p", {}, `No puzzle for ${prettyDate(date)}. `), h("a", { href: "./" }, "Go to today's puzzle")),
    );
    return;
  }
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
