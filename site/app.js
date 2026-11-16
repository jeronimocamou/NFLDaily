// NFL Daily — client. Loads today's puzzle JSON, runs 5 rounds, saves
// progress and stats in localStorage, and builds a shareable result.

const STORE_KEY = "nfldaily:v1";
const TYPE_LABEL = {
  better_record: "Better record",
  odd_one_out: "Odd one out",
  guess_number: "Guess the number",
  rank_four: "Rank four",
};

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
    }
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

// ---- Dates ---------------------------------------------------------------
function localISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return localISO(new Date(y, m - 1, d + n));
}
function prettyDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ---- Storage (never fatal: private mode can throw) -------------------------
function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || { games: {} };
  } catch {
    return { games: {} };
  }
}
function saveStore(store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* progress just won't persist */
  }
}

// ---- Scoring ---------------------------------------------------------------
function scoreRound(round, guess) {
  switch (round.type) {
    case "better_record":
    case "odd_one_out":
      return guess === round.answer ? 100 : 0;
    case "guess_number": {
      const diff = Math.abs(guess - round.answer);
      const s = round.scoring;
      if (s.type === "steps") return s.steps[diff] ?? 0;
      if (diff <= s.exact) return 100;
      return Math.max(0, Math.round((100 * (s.zero_at - diff)) / (s.zero_at - s.exact)));
    }
    case "rank_four":
      return guess.reduce((sum, opt, i) => sum + (opt === round.answer[i] ? 25 : 0), 0);
  }
  return 0;
}
function tier(score) {
  if (score >= 100) return "good";
  if (score >= 50) return "mid";
  if (score > 0) return "low";
  return "bad";
}
const EMOJI = { good: "🟩", mid: "🟨", low: "🟧", bad: "🟥" };

// ---- App state -------------------------------------------------------------
const params = new URLSearchParams(location.search);
const today = localISO();
const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") || "") ? params.get("date") : today;

let store = loadStore();
let puzzle = null;
let game = null; // { answers: [], scores: [] }
let current = 0; // round index being shown

function persist() {
  store.games[date] = game;
  saveStore(store);
}

// ---- Rendering helpers ------------------------------------------------------
function teamButton(team, { onclick, note, disabled, cls, badge } = {}) {
  return h(
    "button",
    {
      type: "button",
      class: `team-btn ${cls || ""}`,
      style: { "--c1": team.color, "--c2": team.color2 },
      disabled,
      onclick,
    },
    h("span", { class: "name" }, team.name),
    note ? h("span", { class: "note" }, note) : null,
    badge,
  );
}

function renderProgress() {
  const ol = $("#progress");
  ol.replaceChildren(
    ...puzzle.rounds.map((r, i) => {
      const li = h("li", { "aria-label": `Round ${i + 1}` });
      const s = game.scores[i];
      if (s != null) li.dataset.tier = tier(s);
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
  const last = i === puzzle.rounds.length - 1;
  return h(
    "button",
    {
      type: "button",
      class: "btn primary",
      onclick: () => {
        current = i + 1;
        render();
      },
    },
    last ? "See results" : "Next round →",
  );
}

// ---- Round renderers ----------------------------------------------------------
// Each returns a card; when `answered` it shows the reveal.

function renderChoice(round, i) {
  const answered = game.answers[i] != null;
  const pick = game.answers[i];
  const opts = round.options.map((t, idx) => {
    let cls = "";
    let note = null;
    if (answered) {
      note = round.type === "better_record" ? t.record : `${t.record} · ${t.note}`;
      if (idx === round.answer) cls = "correct";
      else if (idx === pick) cls = "wrong";
      else cls = "dim";
    }
    return teamButton(t, {
      cls,
      note,
      disabled: answered,
      onclick: () => answer(i, idx),
    });
  });
  const body = [h("div", { class: `options ${round.options.length === 2 ? "two" : ""}` }, opts)];
  if (answered) {
    const ok = pick === round.answer;
    const right = round.options[round.answer].name;
    body.push(resultBox(game.scores[i], ok ? "Correct!" : `The answer was the ${right}.`, round.fact), nextButton(i));
  }
  return roundShell(round, i, ...body);
}

function renderNumber(round, i) {
  const answered = game.answers[i] != null;
  const step = round.step || 1;
  let value = answered ? game.answers[i] : round.start;
  const display = h("div", { class: "number-display", "aria-live": "polite" }, String(value));
  const slider = h("input", {
    type: "range",
    min: round.min,
    max: round.max,
    step,
    value,
    disabled: answered,
    "aria-label": round.metric === "wins" ? "Wins" : "Points",
  });
  const set = (v) => {
    value = Math.min(round.max, Math.max(round.min, v));
    slider.value = value;
    display.textContent = value;
  };
  slider.addEventListener("input", () => set(Number(slider.value)));
  const bump = round.metric === "wins" ? 1 : 5;
  const body = [
    h(
      "div",
      { class: "number-input" },
      h(
        "div",
        { class: "stepper" },
        h("button", { type: "button", "aria-label": `Minus ${bump}`, disabled: answered, onclick: () => set(value - bump) }, "−"),
        display,
        h("button", { type: "button", "aria-label": `Plus ${bump}`, disabled: answered, onclick: () => set(value + bump) }, "+"),
      ),
      slider,
      h("div", { class: "range-ends" }, h("span", {}, round.min), h("span", {}, round.max)),
    ),
  ];
  if (answered) {
    const diff = Math.abs(game.answers[i] - round.answer);
    const line = diff === 0 ? `Exactly right — ${round.answer_label}.` : `Answer: ${round.answer_label}. You were ${diff} off.`;
    body.push(resultBox(game.scores[i], line, round.fact), nextButton(i));
  } else {
    body.push(h("button", { type: "button", class: "btn primary", onclick: () => answer(i, value) }, "Lock it in"));
  }
  return roundShell(round, i, ...body);
}

function renderRank(round, i) {
  const answered = game.answers[i] != null;
  const order = answered ? game.answers[i] : [];
  const card = roundShell(round, i);
  const list = h("div", { class: "options rank" });
  const submit = h("button", { type: "button", class: "btn primary", disabled: true }, "Lock it in");

  const draw = () => {
    if (answered) {
      // Show the correct order, marking where the player put each team.
      list.replaceChildren(
        ...round.answer.map((optIdx, pos) => {
          const t = round.options[optIdx];
          const ok = order[pos] === optIdx;
          const yours = order.indexOf(optIdx) + 1;
          return teamButton(t, {
            disabled: true,
            cls: ok ? "correct" : "wrong",
            note: `${t.note}${ok ? "" : ` · you had #${yours}`}`,
            badge: h("span", { class: `badge ${ok ? "ok" : "no"}` }, String(pos + 1)),
          });
        }),
      );
      return;
    }
    list.replaceChildren(
      ...round.options.map((t, idx) => {
        const pos = order.indexOf(idx);
        return teamButton(t, {
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

  card.append(h("p", { class: "hint" }, answered ? "Correct order:" : "Tap teams from best to worst. Tap again to undo."), list);
  if (answered) {
    const n = game.scores[i] / 25;
    card.append(resultBox(game.scores[i], `You placed ${n} of 4 correctly.`, round.fact), nextButton(i));
  } else {
    card.append(submit);
  }
  return card;
}

function renderSummary() {
  const total = game.scores.reduce((a, b) => a + b, 0);
  const grid = game.scores.map((s) => EMOJI[tier(s)]).join("");
  const toast = h("p", { class: "toast", role: "status" });
  const shareText = `NFL Daily #${puzzle.number} — ${total}/500\n${grid}\n${location.origin}${location.pathname}`;

  const share = async () => {
    // Native share sheet on phones; clipboard elsewhere.
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
      toast.textContent = "Couldn't copy — select and copy the text above.";
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

  return h(
    "article",
    { class: "card summary" },
    h("div", { class: "round-label" }, h("span", {}, `Puzzle #${puzzle.number}`), h("span", {}, prettyDate(puzzle.date))),
    h("p", { class: "big" }, String(total)),
    h("p", { class: "out-of" }, "out of 500"),
    h("div", { class: "grid", "aria-label": "Result grid" }, grid),
    h("button", { type: "button", class: "btn primary", onclick: share }, "Share result"),
    toast,
    h(
      "ol",
      { class: "summary-list" },
      puzzle.rounds.map((r, i) =>
        h(
          "li",
          {},
          h("span", {}, `${EMOJI[tier(game.scores[i])]} ${r.season} · ${TYPE_LABEL[r.type]}`),
          h("span", { class: "score" }, `${game.scores[i]} pts`),
        ),
      ),
    ),
    h("button", { type: "button", class: "btn", onclick: openStats }, "View stats"),
    date === today ? nextIn : null,
  );
}

// ---- Flow ---------------------------------------------------------------------
function answer(i, guess) {
  if (game.answers[i] != null) return;
  game.answers[i] = guess;
  game.scores[i] = scoreRound(puzzle.rounds[i], guess);
  if (game.scores.filter((s) => s != null).length === puzzle.rounds.length) {
    game.completed = true;
    game.total = game.scores.reduce((a, b) => a + b, 0);
  }
  persist();
  render();
}

function render() {
  renderProgress();
  const stage = $("#stage");
  if (current >= puzzle.rounds.length) {
    stage.replaceChildren(renderSummary());
    return;
  }
  const round = puzzle.rounds[current];
  const card =
    round.type === "guess_number" ? renderNumber(round, current)
    : round.type === "rank_four" ? renderRank(round, current)
    : renderChoice(round, current);
  stage.replaceChildren(card);
}

// ---- Stats ---------------------------------------------------------------------
function computeStats() {
  const done = Object.entries(store.games).filter(([, g]) => g.completed);
  const dates = new Set(done.map(([d]) => d));
  const totals = done.map(([, g]) => g.total);
  // Current streak: consecutive completed days ending today (or yesterday if today isn't done yet).
  let streak = 0;
  let d = dates.has(today) ? today : addDays(today, -1);
  while (dates.has(d)) {
    streak++;
    d = addDays(d, -1);
  }
  let best = 0;
  for (const day of [...dates].sort()) {
    let run = 1;
    let prev = addDays(day, -1);
    while (dates.has(prev)) {
      run++;
      prev = addDays(prev, -1);
    }
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

function openStats() {
  const s = computeStats();
  const stat = (n, l) => h("div", {}, h("div", { class: "n" }, String(n)), h("div", { class: "l" }, l));
  $("#stats-body").replaceChildren(
    h("div", { class: "stat-row" }, stat(s.played, "Played"), stat(s.avg, "Avg score"), stat(s.streak, "Streak"), stat(s.best, "Best streak")),
    h("p", { class: "hint", style: { textAlign: "center", marginTop: "14px" } }, `High score: ${s.high} / 500`),
  );
  $("#stats").showModal();
}

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
$("#stats-btn").addEventListener("click", openStats);

// ---- Boot -------------------------------------------------------------------------
async function boot() {
  $("#puzzle-meta").textContent = prettyDate(date);
  try {
    const res = await fetch(`puzzles/${date}.json`, { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    puzzle = await res.json();
  } catch {
    $("#stage").replaceChildren(
      h("div", { class: "card empty" }, h("p", {}, `No puzzle for ${prettyDate(date)} yet. Check back soon!`)),
    );
    return;
  }
  $("#puzzle-meta").textContent = `#${puzzle.number} · ${prettyDate(date)}`;
  game = store.games[date] || { answers: [], scores: [] };
  // Resume at the first unanswered round (or the summary if finished).
  current = game.completed ? puzzle.rounds.length : game.answers.filter((a) => a != null).length;
  render();

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
