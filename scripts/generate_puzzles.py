#!/usr/bin/env python3
"""Generate daily puzzle files from data/nfl.sqlite.

Each day is one football drive: 24 plays (questions) in a fixed order plus an
extra-point and a two-point question. Play calls map to question types:
  Quick pass        head_to_head  - better record / bigger stat (close calls only)
  Slant route       odd_one_out   - the team that doesn't belong (playoffs)
  Deep shot         guess_number  - a team's wins/points or a player's stat
  Run up the middle rank_four     - order a division, 4 teams or 4 players
  Flea flicker      who_am_i      - name the player from a stat line

Every round has public fields (sent to the browser before answering) and a
`reveal` object (answer, notes, fact) that only the API sends back after a
guess. Output goes to puzzles/ at the repo root, which is NOT served
statically, so answers and future puzzles stay private.

New days are appended after the last existing day. Past puzzles are never\nrewritten (unless --rebuild), and puzzles/state.json remembers every question\nalready used so none repeats.

Usage: python3 scripts/generate_puzzles.py [--through 2028-01-01]\n\nExisting days are never changed; only missing days after the last one are added.
"""
import argparse
import datetime as dt
import json
import random
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "nfl.sqlite"
FACTS = ROOT / "data" / "facts.json"
OUT = ROOT / "puzzles"
LAUNCH = dt.date(2026, 11, 1)  # Puzzle #1

PLAYS = 24  # questions available per drive (the clock usually ends it well before)
# How often each play call shows up in a drive.
PLAY_MIX = {"head_to_head": 6, "odd_one_out": 4, "guess_number": 6, "rank_four": 4, "who_am_i": 3}
CALLS = {"head_to_head": "Quick pass", "odd_one_out": "Slant route", "guess_number": "Deep shot",
         "rank_four": "Run up the middle", "who_am_i": "Flea flicker"}

POS_LABEL = {"QB": "quarterback", "RB": "running back", "WR": "wide receiver", "TE": "tight end"}

# Player stats usable in questions: label, unit, positions, minimum to be "notable".
PLAYER_STATS = {
    "passing_yards": dict(label="passing yards", unit="yds", pos=("QB",), min=3000),
    "passing_tds": dict(label="touchdown passes", unit="TD", pos=("QB",), min=20),
    "rushing_yards": dict(label="rushing yards", unit="yds", pos=("RB",), min=900),
    "receiving_yards": dict(label="receiving yards", unit="yds", pos=("WR", "TE"), min=1000),
    "receptions": dict(label="receptions", unit="catches", pos=("WR", "TE"), min=80),
}

# Guess-the-number settings per metric. scoring: full marks within `exact`,
# falling linearly to 0 at `zero_at` off.
GUESS = {
    "wins": dict(min=0, step=1, bump=1, scoring={"type": "steps", "steps": [100, 60, 30, 10]}),
    "passing_yards": dict(min=2000, max=5600, step=25, bump=100, scoring={"type": "linear", "exact": 100, "zero_at": 1000}),
    "passing_tds": dict(min=5, max=60, step=1, bump=1, scoring={"type": "linear", "exact": 1, "zero_at": 12}),
    "rushing_yards": dict(min=500, max=2200, step=10, bump=50, scoring={"type": "linear", "exact": 50, "zero_at": 650}),
    "receiving_yards": dict(min=600, max=2000, step=10, bump=50, scoring={"type": "linear", "exact": 50, "zero_at": 650}),
    "receptions": dict(min=40, max=150, step=1, bump=1, scoring={"type": "linear", "exact": 3, "zero_at": 35}),
}


# ---- All-time questions (the data starts in 1999, so these say "since 1999") ----
REUSE_DAYS = 365  # a question can come back after a year
ALL_TIME = 0.6  # share of plays that ask about careers or franchises instead of one season
ERA = "Since 1999"
CAREER_STATS = {
    "passing_yards": dict(label="passing yards", unit="yds", pos=("QB",), min=25000, odd=50000, gap=2500,
                          guess=dict(min=10000, max=95000, step=100, bump=1000, scoring={"type": "linear", "exact": 1000, "zero_at": 12000})),
    "passing_tds": dict(label="touchdown passes", unit="TD", pos=("QB",), min=150, odd=300, gap=15,
                        guess=dict(min=50, max=700, step=1, bump=5, scoring={"type": "linear", "exact": 8, "zero_at": 100})),
    "rushing_yards": dict(label="rushing yards", unit="yds", pos=("RB",), min=6000, odd=10000, gap=500,
                          guess=dict(min=2000, max=18000, step=50, bump=250, scoring={"type": "linear", "exact": 300, "zero_at": 3500})),
    "receiving_yards": dict(label="receiving yards", unit="yds", pos=("WR", "TE"), min=7000, odd=12000, gap=500,
                            guess=dict(min=3000, max=19000, step=50, bump=250, scoring={"type": "linear", "exact": 300, "zero_at": 3500})),
    "receptions": dict(label="receptions", unit="catches", pos=("WR", "TE"), min=550, odd=1000, gap=40,
                       guess=dict(min=300, max=1700, step=5, bump=20, scoring={"type": "linear", "exact": 25, "zero_at": 300})),
}
FRANCHISE_STATS = {
    "wins": dict(label="regular-season wins", gap=8, close=(1, 15),
                 guess=dict(min=100, max=350, step=1, bump=5, scoring={"type": "linear", "exact": 5, "zero_at": 60})),
    "playoff_apps": dict(label="playoff appearances", gap=1, close=(1, 2),
                         guess=dict(min=0, max=27, step=1, bump=1, scoring={"type": "steps", "steps": [100, 60, 30, 10]})),
    "playoff_wins": dict(label="playoff wins", gap=1, close=(1, 3),
                         guess=dict(min=0, max=45, step=1, bump=1, scoring={"type": "steps", "steps": [100, 60, 30, 10]})),
    "winning_seasons": dict(label="winning seasons", gap=1, close=(1, 2),
                            guess=dict(min=0, max=27, step=1, bump=1, scoring={"type": "steps", "steps": [100, 60, 30, 10]})),
}


def fmt(n):
    return f"{n:,}"


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


class Data:
    def __init__(self):
        con = sqlite3.connect(DB)
        con.row_factory = sqlite3.Row
        colors = {r["franchise"]: (r["color"], r["color2"]) for r in con.execute("SELECT * FROM franchises")}
        self.rows = [dict(r) for r in con.execute("SELECT * FROM team_seasons")]
        self.players = [dict(r) for r in con.execute("SELECT * FROM player_seasons")]
        for r in self.rows + self.players:
            r["color"], r["color2"] = colors[r["franchise"]]
        self.seasons = sorted({r["season"] for r in self.rows})
        self.by_season = {s: [r for r in self.rows if r["season"] == s] for s in self.seasons}
        self.players_by_season = {s: [p for p in self.players if p["season"] == s] for s in self.seasons}
        self.team = {(r["season"], r["team"]): r for r in self.rows}
        self.facts = {k: v for k, v in json.loads(FACTS.read_text()).items() if not k.startswith("_")}
        self.first, self.last = self.seasons[0], self.seasons[-1]
        names = {r["franchise"]: r["name"] for r in con.execute("SELECT franchise, name FROM franchises")}
        self.careers = self._careers()
        self.franchises = self._franchises(names, colors)

    def _careers(self):
        by = {}
        for p in self.players:
            c = by.setdefault(p["player_id"], {"player_id": p["player_id"], "name": p["name"], "pos": {}, "teams": {},
                                                 "seasons": set(), "games": 0, "completions": 0, "attempts": 0,
                                                 "passing_yards": 0, "passing_tds": 0, "interceptions": 0, "carries": 0,
                                                 "rushing_yards": 0, "rushing_tds": 0, "receptions": 0,
                                                 "receiving_yards": 0, "receiving_tds": 0})
            c["pos"][p["position"]] = c["pos"].get(p["position"], 0) + 1
            c["teams"][(p["team_name"], p["franchise"])] = c["teams"].get((p["team_name"], p["franchise"]), 0) + 1
            c["seasons"].add(p["season"])
            for k in ("games", "completions", "attempts", "passing_yards", "passing_tds", "interceptions", "carries",
                      "rushing_yards", "rushing_tds", "receptions", "receiving_yards", "receiving_tds"):
                c[k] += p[k]
        colors = {p["franchise"]: (p["color"], p["color2"]) for p in self.players}
        out = []
        for c in by.values():
            c["position"] = max(c["pos"], key=c["pos"].get)
            (c["team_name"], fr), _ = max(c["teams"].items(), key=lambda kv: kv[1])
            c["color"], c["color2"] = colors[fr]
            c["start"], c["end"] = min(c["seasons"]), max(c["seasons"])
            c["n_seasons"] = len(c["seasons"])
            out.append(c)
        return out

    def _franchises(self, names, colors):
        out = {}
        for r in self.rows:
            f = out.setdefault(r["franchise"], {"franchise": r["franchise"], "name": names[r["franchise"]],
                                                "color": colors[r["franchise"]][0], "color2": colors[r["franchise"]][1],
                                                "wins": 0, "losses": 0, "ties": 0, "playoff_apps": 0, "playoff_wins": 0,
                                                "sb_wins": 0, "sb_apps": 0, "winning_seasons": 0, "old_names": set()})
            f["wins"] += r["wins"]; f["losses"] += r["losses"]; f["ties"] += r["ties"]
            f["playoff_apps"] += r["made_playoffs"]; f["playoff_wins"] += r["playoff_wins"]
            f["sb_wins"] += r["won_super_bowl"]; f["sb_apps"] += r["won_super_bowl"] + r["lost_super_bowl"]
            f["winning_seasons"] += r["wins"] > r["losses"]
            if r["name"].split()[-1] == f["name"].split()[-1] and r["name"] != f["name"]:
                f["old_names"].add(r["name"])
        return list(out.values())

    def career_pool(self, stat):
        if not hasattr(self, "_pools"):
            self._pools = {}
        if stat not in self._pools:
            cfg = CAREER_STATS[stat]
            self._pools[stat] = [c for c in self.careers if c["position"] in cfg["pos"] and c[stat] >= cfg["min"]]
        return self._pools[stat]

    def notable(self, season, stat):
        cfg = PLAYER_STATS[stat]
        return [p for p in self.players_by_season[season]
                if p["position"] in cfg["pos"] and p[stat] >= cfg["min"]]


# ---- Option/fact helpers ------------------------------------------------------

def team_opt(r):
    return {"name": r["name"], "color": r["color"], "color2": r["color2"]}


def player_opt(p):
    return {"name": p["name"], "sub": f"{p['position']} · {p['team_name']}",
            "color": p["color"], "color2": p["color2"]}


def career_opt(c):
    return {"name": c["name"], "sub": f"{c['position']} · {c['start']}–{c['end']}", "color": c["color"], "color2": c["color2"]}


def franchise_opt(f):
    return {"name": f["name"], "color": f["color"], "color2": f["color2"]}


def career_fact(d, c):
    if c["position"] == "QB":
        main = f"threw for {fmt(c['passing_yards'])} yards and {c['passing_tds']} TDs"
    elif c["position"] == "RB":
        main = f"ran for {fmt(c['rushing_yards'])} yards and {c['rushing_tds']} TDs"
    else:
        main = f"caught {fmt(c['receptions'])} passes for {fmt(c['receiving_yards'])} yards and {c['receiving_tds']} TDs"
    span = f"{c['n_seasons']} season{'s' if c['n_seasons'] != 1 else ''} ({c['start']}–{c['end']})"
    note = f" Totals count regular-season games from {d.first} on." if c["start"] == d.first else ""
    return f"From {d.first} to {d.last}, {c['name']} {main} in {span}, mostly with the {c['team_name']}.{note}"


def franchise_fact(d, f):
    rec = f"{f['wins']}-{f['losses']}" + (f"-{f['ties']}" if f["ties"] else "")
    moved = f" (counting their years as the {' and '.join(sorted(f['old_names']))})" if f["old_names"] else ""
    sb = f"{f['sb_wins']} Super Bowl title{'s' if f['sb_wins'] != 1 else ''}" if f["sb_wins"] else "no Super Bowl titles"
    return (f"From {d.first} to {d.last}, the {f['name']}{moved} went {rec} with {f['playoff_apps']} playoff trips, "
            f"{f['playoff_wins']} playoff wins and {sb}.")


def career_line(c):
    yrs = f"{c['n_seasons']} seasons"
    if c["position"] == "QB":
        pct = 100 * c["completions"] / c["attempts"] if c["attempts"] else 0
        return [yrs, f"{fmt(c['passing_yards'])} passing yds", f"{c['passing_tds']} TD", f"{c['interceptions']} INT", f"{pct:.1f}% completions"]
    if c["position"] == "RB":
        ypc = c["rushing_yards"] / c["carries"] if c["carries"] else 0
        return [yrs, f"{fmt(c['rushing_yards'])} rushing yds", f"{c['rushing_tds']} rushing TD", f"{ypc:.1f} yds/carry", f"{fmt(c['receptions'])} catches"]
    return [yrs, f"{fmt(c['receptions'])} catches", f"{fmt(c['receiving_yards'])} receiving yds", f"{c['receiving_tds']} TD"]


def split_game(text):
    """'37-5 vs the Buffalo Bills in Week 7' -> ('37-5', 'Buffalo Bills', '7')."""
    score, rest = text.split(" vs the ", 1)
    opp, week = rest.rsplit(" in Week ", 1)
    return score, opp, week


def team_fact(d, r):
    """Most interesting sentence about a team-season."""
    s, n, rec = r["season"], r["name"], r["record"]
    curated = d.facts.get(f"{s}-{r['team']}")
    if curated:
        return curated
    ex = f" They {r['playoff_exit']}." if r["playoff_exit"] else ""
    if r["won_super_bowl"]:
        return f"The {s} {n} went {rec} under {r['head_coach']} and won the Super Bowl."
    if r["start_record"] in ("0-8", "8-0", "1-7", "7-1"):
        return f"The {s} {n} started {r['start_record']} and finished {rec}.{ex}"
    if r["longest_win_streak"] >= 8:
        return f"The {s} {n} won {r['longest_win_streak']} straight games on the way to a {rec} record.{ex}"
    if r["longest_loss_streak"] >= 8:
        return f"The {s} {n} lost {r['longest_loss_streak']} games in a row during a {rec} season."
    if r["pf_rank"] == 1:
        return f"The {s} {n} ({rec}) led the NFL with {r['points_for']} points, with {r['qb']} at quarterback.{ex}"
    if r["pa_rank"] == 1:
        return f"The {s} {n} ({rec}) allowed the fewest points in the league ({r['points_against']}).{ex}"
    if r["wins"] >= 10 and not r["made_playoffs"]:
        return f"The {s} {n} went {rec} and still missed the playoffs."
    if r["made_playoffs"] and r["wins"] <= 8:
        return f"The {s} {n} snuck into the playoffs at {rec}.{ex}"
    if r["division_record"] in ("6-0", "0-6"):
        word = "swept their division rivals" if r["division_record"] == "6-0" else "lost all six division games"
        return f"The {s} {n} ({rec}) {word}.{ex}"
    w, l = r["one_score_wins"], r["one_score_losses"]
    if w + l >= 6 and (w / (w + l) >= .85 or w / (w + l) <= .15):
        return f"The {s} {n} ({rec}) went {r['one_score_record']} in games decided by 8 points or less.{ex}"
    if r["biggest_win_margin"] and r["biggest_win_margin"] >= 30:
        score, opp, week = split_game(r["biggest_win"])
        return f"The {s} {n} ({rec}) beat the {opp} {score} in Week {week}.{ex}"
    if r["worst_loss_margin"] and r["worst_loss_margin"] >= 35:
        score, opp, week = split_game(r["worst_loss"])
        return f"The {s} {n} ({rec}) lost {score} to the {opp} in Week {week}.{ex}"
    if r["home_record"] in ("8-0", "0-8"):
        return f"The {s} {n} went {r['home_record']} at home and {rec} overall.{ex}"
    qb = f", with {r['qb']} at QB" if r["qb"] else ""
    return f"Under {r['head_coach']}{qb}, the {s} {n} went {rec}.{ex or ' They missed the playoffs.'}"


def player_line(p):
    if p["position"] == "QB":
        pct = 100 * p["completions"] / p["attempts"] if p["attempts"] else 0
        return [f"{fmt(p['passing_yards'])} passing yds", f"{p['passing_tds']} TD", f"{p['interceptions']} INT",
                f"{pct:.1f}% completions", f"{fmt(p['rushing_yards'])} rushing yds"]
    if p["position"] == "RB":
        ypc = p["rushing_yards"] / p["carries"] if p["carries"] else 0
        return [f"{fmt(p['rushing_yards'])} rushing yds", f"{p['rushing_tds']} rushing TD",
                f"{ypc:.1f} yds/carry", f"{p['receptions']} catches", f"{fmt(p['receiving_yards'])} receiving yds"]
    return [f"{fmt(p['receiving_yards'])} receiving yds", f"{p['receptions']} catches",
            f"{p['receiving_tds']} TD", f"{p['targets']} targets"]


def player_fact(d, p, stat=None):
    t = d.team[(p["season"], p["team"])]
    if p["position"] == "QB":
        main = f"threw for {fmt(p['passing_yards'])} yards and {p['passing_tds']} TDs"
    elif p["position"] == "RB":
        main = f"ran for {fmt(p['rushing_yards'])} yards and {p['rushing_tds']} TDs"
    else:
        main = f"caught {p['receptions']} passes for {fmt(p['receiving_yards'])} yards and {p['receiving_tds']} TDs"
    rank_key = {"QB": "passing_yards_rank", "RB": "rushing_yards_rank"}.get(p["position"], "receiving_yards_rank")
    if stat in ("passing_yards", "passing_tds", "rushing_yards", "receiving_yards"):
        rank_key = f"{stat}_rank"
    label = {"passing_yards_rank": "passing yards", "passing_tds_rank": "TD passes",
             "rushing_yards_rank": "rushing yards", "receiving_yards_rank": "receiving yards",
             "receptions_rank": "receptions"}[rank_key]
    rank = p[rank_key]
    rank_txt = f", leading the NFL in {label}" if rank == 1 else f" ({ordinal(rank)} in the NFL in {label})" if rank <= 10 else ""
    exit_ = f" and {t['playoff_exit']}" if t["playoff_exit"] else ""
    return f"{p['name']} {main} for the {p['season']} {p['team_name']}{rank_txt}. The team went {t['record']}{exit_}."


# ---- Generator ------------------------------------------------------------------

class Generator:
    def __init__(self, data):
        self.d = data
        self.used = {}  # question key -> date it was used
        self.date = LAUNCH
        self.today = set()

    def day_fresh(self, *subject):
        """True if `subject` hasn't been the answer to an all-time question yet today."""
        if subject in self.today:
            return False
        self.today.add(subject)
        return True

    def fresh(self, key):
        """True (and marks it used) if this question hasn't been asked in the last REUSE_DAYS days."""
        last = self.used.get(key)
        if last is not None and (self.date - last).days < REUSE_DAYS:
            return False
        self.used[key] = self.date
        return True

    def recently_used(self, key):
        last = self.used.get(key)
        return last is not None and (self.date - last).days < REUSE_DAYS

    # Round 1 ----------------------------------------------------------------
    def head_to_head(self, rng, season):
        if rng.random() < ALL_TIME:
            r = self.at_head_to_head(rng)
            if r:
                return r
        if rng.random() < 0.5:
            return self.h2h_players(rng, season) or self.h2h_teams(rng, season)
        return self.h2h_teams(rng, season)

    def h2h_teams(self, rng, season):
        teams = self.d.by_season[season]
        for _ in range(500):
            a, b = rng.sample(teams, 2)
            gap = abs(a["win_pct"] - b["win_pct"]) * a["games"]
            if not (1 <= gap <= 3) or not self.fresh(("h2h", season, *sorted((a["team"], b["team"])))):
                continue
            ans = 0 if a["win_pct"] > b["win_pct"] else 1
            return {
                "type": "head_to_head", "kind": "team", "season": season,
                "prompt": f"In {season}, who had the better regular-season record?",
                "options": [team_opt(a), team_opt(b)],
                "reveal": {"answer": ans, "notes": [a["record"], b["record"]],
                           "fact": team_fact(self.d, (a, b)[ans])},
            }
        raise RuntimeError("no team pair")

    def h2h_players(self, rng, season):
        stat = rng.choice(list(PLAYER_STATS))
        cfg = PLAYER_STATS[stat]
        pool = self.d.notable(season, stat)
        for _ in range(300):
            if len(pool) < 2:
                return None
            a, b = rng.sample(pool, 2)
            hi, lo = max(a[stat], b[stat]), min(a[stat], b[stat])
            if hi == lo or (hi - lo) / hi > 0.15:
                continue
            if not self.fresh(("h2hp", season, stat, *sorted((a["player_id"], b["player_id"])))):
                continue
            ans = 0 if a[stat] > b[stat] else 1
            verb = {"passing_yards": "threw for more", "passing_tds": "threw more",
                    "rushing_yards": "ran for more", "receiving_yards": "had more",
                    "receptions": "had more"}[stat]
            return {
                "type": "head_to_head", "kind": "player", "season": season,
                "prompt": f"In {season}, who {verb} {cfg['label']}?",
                "options": [player_opt(a), player_opt(b)],
                "reveal": {"answer": ans,
                           "notes": [f"{fmt(a[stat])} {cfg['unit']}", f"{fmt(b[stat])} {cfg['unit']}"],
                           "fact": player_fact(self.d, (a, b)[ans], stat)},
            }
        return None

    # Round 2 ----------------------------------------------------------------
    def odd_one_out(self, rng, season):
        if rng.random() < ALL_TIME:
            r = self.at_odd_one_out(rng)
            if r:
                return r
        teams = self.d.by_season[season]
        playoff = [t for t in teams if t["made_playoffs"]]
        missed = [t for t in teams if not t["made_playoffs"]]

        def unused(pool):
            return [t for t in pool if not self.recently_used(("ooo", season, t["team"]))]

        for _ in range(500):
            if rng.random() < 0.6:
                odd = rng.choice(unused([t for t in missed if t["wins"] >= 8]) or unused(missed) or missed)
                others = rng.sample(playoff, 3)
                prompt = f"Which of these teams did NOT make the {season} playoffs?"
            else:
                odd = rng.choice(unused([t for t in playoff if t["wins"] <= 11]) or unused(playoff) or playoff)
                others = rng.sample([t for t in missed if t["wins"] >= 6] or missed, 3)
                prompt = f"Only one of these teams made the {season} playoffs. Which one?"
            # Each team is the odd one out once per season; after that it can
            # come back, but never with the same three other teams.
            if not self.fresh(("ooo", season, odd["team"])) and not self.fresh(
                    ("ooo2", season, odd["team"], *sorted(t["team"] for t in others))):
                continue
            opts = others + [odd]
            rng.shuffle(opts)
            return {
                "type": "odd_one_out", "season": season, "prompt": prompt,
                "options": [team_opt(t) for t in opts],
                "reveal": {"answer": opts.index(odd),
                           "notes": [f"{t['record']} · {t['playoff_exit'] or 'missed playoffs'}" for t in opts],
                           "fact": team_fact(self.d, odd)},
            }
        raise RuntimeError("no odd one out")

    # Round 3 ----------------------------------------------------------------
    def guess_number(self, rng, season):
        if rng.random() < ALL_TIME:
            r = self.at_guess_number(rng)
            if r:
                return r
        kind = rng.choice(["wins", "player", "player"])
        order = [kind] + [k for k in ("player", "wins") if k != kind]
        for k in order:
            r = self.guess_player(rng, season) if k == "player" else self.guess_team(rng, season, k)
            if r:
                return r
        raise RuntimeError("no guess")

    def guess_team(self, rng, season, metric):
        teams = self.d.by_season[season]
        for _ in range(500):
            t = rng.choice(teams)
            if not self.fresh(("gn", season, t["team"], metric)):
                continue
            g = GUESS[metric]
            prompt = f"How many regular-season games did the {season} {t['name']} win?"
            hint = f"They played {t['games']} games."
            lo, hi, start, label = 0, t["games"], t["games"] // 2, f"{t['wins']} wins ({t['record']})"
            return {
                "type": "guess_number", "metric": metric, "season": season, "prompt": prompt, "hint": hint,
                "subject": team_opt(t), "min": lo, "max": hi, "start": start,
                "step": g["step"], "bump": g["bump"], "scoring": g["scoring"],
                "reveal": {"answer": t[metric], "answer_label": label, "fact": team_fact(self.d, t)},
            }
        return None

    def guess_player(self, rng, season):
        stat = rng.choice(list(PLAYER_STATS))
        cfg, g = PLAYER_STATS[stat], GUESS[stat]
        pool = self.d.notable(season, stat)
        rng.shuffle(pool)
        for p in pool:
            if not self.fresh(("gnp", season, p["player_id"], stat)):
                continue
            verb = {"passing_yards": "throw for", "passing_tds": "throw", "rushing_yards": "run for",
                    "receiving_yards": "have", "receptions": "have"}[stat]
            return {
                "type": "guess_number", "metric": stat, "season": season,
                "prompt": f"How many {cfg['label']} did {p['name']} {verb} in {season}?",
                "hint": f"He played {p['games']} games that season.",
                "subject": player_opt(p), "min": g["min"], "max": g["max"],
                "start": round((g["min"] + g["max"]) / 2 / g["step"]) * g["step"],
                "step": g["step"], "bump": g["bump"], "scoring": g["scoring"],
                "reveal": {"answer": p[stat], "answer_label": f"{fmt(p[stat])} {cfg['label']}",
                           "fact": player_fact(self.d, p, stat)},
            }
        return None

    # Round 4 ----------------------------------------------------------------
    def rank_four(self, rng, season):
        if rng.random() < ALL_TIME:
            r = self.at_rank_four(rng)
            if r:
                return r
        if rng.random() < 0.35:
            r = self.rank_players(rng, season)
            if r:
                return r
        return self.rank_teams(rng, season)

    def rank_teams(self, rng, season):
        teams = self.d.by_season[season]
        divisions = sorted({t["division"] for t in teams if t["division"]})
        for attempt in range(500):
            metric = "wins"  # (no points-scored questions)
            key = "win_pct"
            if divisions and attempt < 40:
                div = rng.choice(divisions)
                members = [t for t in teams if t["division"] == div]
                group = f"the {season} {div}"
                dedup = ("r4", season, div, metric)
            else:
                members = rng.sample(teams, 4)
                vals = sorted(t[key] * (t["games"] if key == "win_pct" else 1) for t in members)
                min_gap = 1
                if any(b - a < min_gap for a, b in zip(vals, vals[1:])):
                    continue
                group = f"these {season} teams"
                dedup = ("r4", season, *sorted(t["team"] for t in members), metric)
            if len({t[key] for t in members}) < 4 or not self.fresh(dedup):
                continue
            ordered = sorted(members, key=lambda t: t[key], reverse=True)
            shown = members[:]
            rng.shuffle(shown)
            label = "regular-season record"
            return {
                "type": "rank_four", "kind": "team", "season": season,
                "prompt": f"Rank {group} by {label}, best first.",
                "options": [team_opt(t) for t in shown],
                "reveal": {"answer": [shown.index(t) for t in ordered],
                           "notes": [t["record"] for t in shown],
                           "fact": team_fact(self.d, ordered[0])},
            }
        raise RuntimeError("no rank four")

    def rank_players(self, rng, season):
        stat = rng.choice(["passing_yards", "passing_tds", "rushing_yards", "receiving_yards"])
        cfg = PLAYER_STATS[stat]
        pool = self.d.notable(season, stat)
        gap = {"passing_yards": 150, "passing_tds": 2, "rushing_yards": 75, "receiving_yards": 75}[stat]
        for _ in range(300):
            if len(pool) < 4:
                return None
            members = rng.sample(pool, 4)
            vals = sorted(p[stat] for p in members)
            if any(b - a < gap for a, b in zip(vals, vals[1:])):
                continue
            if not self.fresh(("r4p", season, stat, *sorted(p["player_id"] for p in members))):
                continue
            ordered = sorted(members, key=lambda p: p[stat], reverse=True)
            shown = members[:]
            rng.shuffle(shown)
            who = {"passing_yards": "quarterbacks", "passing_tds": "quarterbacks",
                   "rushing_yards": "running backs", "receiving_yards": "receivers"}[stat]
            return {
                "type": "rank_four", "kind": "player", "season": season,
                "prompt": f"Rank these {season} {who} by {cfg['label']}, most first.",
                "options": [player_opt(p) for p in shown],
                "reveal": {"answer": [shown.index(p) for p in ordered],
                           "notes": [f"{fmt(p[stat])} {cfg['unit']}" for p in shown],
                           "fact": player_fact(self.d, ordered[0], stat)},
            }
        return None

    # Round 5 ----------------------------------------------------------------
    def who_am_i(self, rng, season):
        if rng.random() < ALL_TIME:
            r = self.at_who_am_i(rng)
            if r:
                return r
        first = rng.choice(["QB", "QB", "RB", "WR"])
        # Try the drawn position first (keeps earlier puzzles identical), then the
        # others, then wider pools once the stars of a season have all been used.
        attempts = [(first, False)] + [(p, False) for p in ("QB", "RB", "WR") if p != first] \
            + [(p, True) for p in (first, "QB", "RB", "WR")]
        for pos, wide in attempts:
            stat = {"QB": "passing_yards", "RB": "rushing_yards", "WR": "receiving_yards"}[pos]
            ranked = sorted((p for p in self.d.players_by_season[season] if p["position"] == pos),
                            key=lambda p: -p[stat])
            if wide:
                pool = ranked[:24]
            else:
                pool = [p for p in self.d.notable(season, stat) if p["position"] == pos]
                if pos == "QB":
                    pool = [p for p in pool if p["attempts"] >= 350]
                if len(pool) < 4:
                    pool = ranked[:12]
            pool = pool[:]
            rng.shuffle(pool)
            for target in pool:
                if self.fresh(("who", target["player_id"], season)):
                    others = rng.sample([p for p in pool if p is not target], 3)
                elif wide:
                    # A player only comes back once every star of the season has
                    # been used, and then never with the same three choices.
                    others = rng.sample([p for p in pool if p is not target], 3)
                    if not self.fresh(("who2", target["player_id"], season, *sorted(p["player_id"] for p in others))):
                        continue
                else:
                    continue
                opts = others + [target]
                rng.shuffle(opts)
                return {
                    "type": "who_am_i", "season": season,
                    "prompt": f"Who had this {season} season? ({POS_LABEL[pos]})",
                    "clues": player_line(target),
                    "options": [{"name": p["name"]} for p in opts],
                    "max_attempts": 2,
                    "scoring": {"type": "attempts", "points": [100, 50]},
                    "reveal": {"answer": opts.index(target),
                               "hint": f"He played for the {target['team_name']}.",
                               "notes": [f"{p['position']} · {p['team_name']}" for p in opts],
                               "fact": player_fact(self.d, target)},
                }
        raise RuntimeError("no who am i")

    # All-time (since 1999) questions -------------------------------------------
    def at_head_to_head(self, rng):
        d = self.d
        for _ in range(300):
            if rng.random() < 0.6:
                stat = rng.choice(list(CAREER_STATS))
                cfg = CAREER_STATS[stat]
                pool = d.career_pool(stat)
                a, b = rng.sample(pool, 2)
                hi, lo = max(a[stat], b[stat]), min(a[stat], b[stat])
                if hi == lo or (hi - lo) / hi > 0.12:
                    continue
                if not self.fresh(("ath", stat, *sorted((a["player_id"], b["player_id"])))):
                    continue
                ans = 0 if a[stat] > b[stat] else 1
                return {"type": "head_to_head", "kind": "career", "season": ERA,
                        "prompt": f"Since {d.first}, who has more career {cfg['label']}?",
                        "options": [career_opt(a), career_opt(b)],
                        "reveal": {"answer": ans, "notes": [f"{fmt(a[stat])} {cfg['unit']}", f"{fmt(b[stat])} {cfg['unit']}"],
                                   "fact": career_fact(d, (a, b)[ans])}}
            stat = rng.choice(list(FRANCHISE_STATS))
            cfg = FRANCHISE_STATS[stat]
            a, b = rng.sample(d.franchises, 2)
            lo_gap, hi_gap = cfg["close"]
            if not (lo_gap <= abs(a[stat] - b[stat]) <= hi_gap):
                continue
            if not self.fresh(("ath", stat, *sorted((a["franchise"], b["franchise"])))):
                continue
            ans = 0 if a[stat] > b[stat] else 1
            return {"type": "head_to_head", "kind": "franchise", "season": ERA,
                    "prompt": f"Since {d.first}, which franchise has more {cfg['label']}?",
                    "options": [franchise_opt(a), franchise_opt(b)],
                    "reveal": {"answer": ans, "notes": [f"{a[stat]} {cfg['label']}", f"{b[stat]} {cfg['label']}"],
                               "fact": franchise_fact(d, (a, b)[ans])}}
        return None

    def at_odd_one_out(self, rng):
        d = self.d
        for _ in range(300):
            if rng.random() < 0.5:
                winners = [f for f in d.franchises if f["sb_wins"]]
                others = [f for f in d.franchises if not f["sb_wins"]]
                if rng.random() < 0.5:
                    # Prefer teams that reached a Super Bowl but lost it: trickier.
                    odd = rng.choice([f for f in others if f["sb_apps"]] or others)
                    rest = rng.sample(winners, 3)
                    prompt = f"Which of these franchises has NOT won a Super Bowl since {d.first}?"
                else:
                    odd = rng.choice(winners)
                    rest = rng.sample(others, 3)
                    prompt = f"Only one of these franchises has won a Super Bowl since {d.first}. Which one?"
                if odd["franchise"] in [x[1] for x in self.today if x[0] == "f"] or \
                        not self.fresh(("ato", odd["franchise"], *sorted(f["franchise"] for f in rest))):
                    continue
                self.day_fresh("f", odd["franchise"])
                opts = rest + [odd]
                rng.shuffle(opts)
                return {"type": "odd_one_out", "kind": "franchise", "season": ERA, "prompt": prompt,
                        "options": [franchise_opt(f) for f in opts],
                        "reveal": {"answer": opts.index(odd),
                                   "notes": [f"{f['sb_wins']} title{'s' if f['sb_wins'] != 1 else ''} · {f['sb_apps']} Super Bowl trip{'s' if f['sb_apps'] != 1 else ''}" for f in opts],
                                   "fact": franchise_fact(d, odd)}}
            stat = rng.choice(list(CAREER_STATS))
            cfg = CAREER_STATS[stat]
            pool = d.career_pool(stat)
            over = [c for c in pool if c[stat] >= cfg["odd"]]
            near = [c for c in pool if cfg["odd"] * 0.75 <= c[stat] < cfg["odd"]]
            if len(over) < 3 or not near:
                continue
            odd = rng.choice(near)
            rest = rng.sample(over, 3)
            if ("p", odd["player_id"]) in self.today or \
                    not self.fresh(("ato", stat, odd["player_id"], *sorted(c["player_id"] for c in rest))):
                continue
            self.day_fresh("p", odd["player_id"])
            opts = rest + [odd]
            rng.shuffle(opts)
            return {"type": "odd_one_out", "kind": "career", "season": ERA,
                    "prompt": f"Which of these players has NOT reached {fmt(cfg['odd'])} career {cfg['label']} since {d.first}?",
                    "options": [career_opt(c) for c in opts],
                    "reveal": {"answer": opts.index(odd), "notes": [f"{fmt(c[stat])} {cfg['unit']}" for c in opts],
                               "fact": career_fact(d, odd)}}
        return None

    def at_guess_number(self, rng):
        d = self.d
        for _ in range(300):
            if rng.random() < 0.65:
                stat = rng.choice(list(CAREER_STATS))
                cfg = CAREER_STATS[stat]
                g = cfg["guess"]
                c = rng.choice(d.career_pool(stat))
                if not g["min"] <= c[stat] <= g["max"] or ("p", c["player_id"]) in self.today or \
                        not self.fresh(("atg", stat, c["player_id"])):
                    continue
                self.day_fresh("p", c["player_id"])
                verb = {"passing_yards": "throw for", "passing_tds": "throw", "rushing_yards": "run for",
                        "receiving_yards": "have", "receptions": "have"}[stat]
                return {"type": "guess_number", "metric": f"career_{stat}", "season": ERA,
                        "prompt": f"How many regular-season {cfg['label']} did {c['name']} {verb} from {d.first} through {d.last}?",
                        "hint": f"{POS_LABEL.get(c['position'], c['position']).capitalize()}, {c['n_seasons']} seasons ({c['start']}–{c['end']}).",
                        "subject": career_opt(c), "min": g["min"], "max": g["max"],
                        "start": round((g["min"] + g["max"]) / 2 / g["step"]) * g["step"],
                        "step": g["step"], "bump": g["bump"], "scoring": g["scoring"],
                        "reveal": {"answer": c[stat], "answer_label": f"{fmt(c[stat])} {cfg['label']}", "fact": career_fact(d, c)}}
            stat = rng.choice(list(FRANCHISE_STATS))
            cfg = FRANCHISE_STATS[stat]
            g = cfg["guess"]
            f = rng.choice(d.franchises)
            if ("f", f["franchise"]) in self.today or not self.fresh(("atg", stat, f["franchise"])):
                continue
            self.day_fresh("f", f["franchise"])
            n = len(d.seasons)
            games = f["wins"] + f["losses"] + f["ties"]
            hi = n if stat in ("playoff_apps", "winning_seasons") else g["max"]
            return {"type": "guess_number", "metric": f"franchise_{stat}", "season": ERA,
                    "prompt": f"How many {cfg['label']} have the {f['name']} had from {d.first} through {d.last}?",
                    "hint": f"That's {n} seasons and {games} regular-season games.",
                    "subject": franchise_opt(f), "min": g["min"], "max": hi, "start": (g["min"] + hi) // 2,
                    "step": g["step"], "bump": g["bump"], "scoring": g["scoring"],
                    "reveal": {"answer": f[stat], "answer_label": f"{f[stat]} {cfg['label']}", "fact": franchise_fact(d, f)}}
        return None

    def at_rank_four(self, rng):
        d = self.d
        for _ in range(300):
            if rng.random() < 0.6:
                stat = rng.choice(list(CAREER_STATS))
                cfg = CAREER_STATS[stat]
                pool = d.career_pool(stat)
                if len(pool) < 4:
                    continue
                members = rng.sample(pool, 4)
                key = lambda c: c[stat]
                ident = lambda c: c["player_id"]
                opt, fact, unit = career_opt, career_fact, cfg["unit"]
                who = {"passing_yards": "quarterbacks", "passing_tds": "quarterbacks", "rushing_yards": "running backs"}.get(stat, "receivers")
                prompt = f"Rank these {who} by career {cfg['label']} since {d.first}, most first."
            else:
                stat = rng.choice(list(FRANCHISE_STATS))
                cfg = FRANCHISE_STATS[stat]
                members = rng.sample(d.franchises, 4)
                key = lambda f: f[stat]
                ident = lambda f: f["franchise"]
                opt, fact, unit = franchise_opt, franchise_fact, ""
                prompt = f"Rank these franchises by {cfg['label']} since {d.first}, most first."
            vals = sorted(key(m) for m in members)
            if any(b - a < cfg["gap"] for a, b in zip(vals, vals[1:])):
                continue
            if not self.fresh(("atr", stat, *sorted(ident(m) for m in members))):
                continue
            ordered = sorted(members, key=key, reverse=True)
            shown = members[:]
            rng.shuffle(shown)
            return {"type": "rank_four", "kind": "all_time", "season": ERA, "prompt": prompt,
                    "options": [opt(m) for m in shown],
                    "reveal": {"answer": [shown.index(m) for m in ordered],
                               "notes": [f"{fmt(key(m))} {unit or cfg['label']}".strip() for m in shown],
                               "fact": fact(d, ordered[0])}}
        return None

    def at_who_am_i(self, rng):
        d = self.d
        for _ in range(100):
            pos = rng.choice(["QB", "QB", "RB", "WR"])
            stat = {"QB": "passing_yards", "RB": "rushing_yards", "WR": "receiving_yards"}[pos]
            pool = [c for c in d.career_pool(stat) if c["position"] == pos]
            target = rng.choice(pool)
            # Decoys from roughly the same era, so the years don't give it away.
            era = [c for c in pool if c is not target and abs(c["start"] - target["start"]) <= 6]
            if len(era) < 3 or ("p", target["player_id"]) in self.today or not self.fresh(("atw", target["player_id"])):
                continue
            self.day_fresh("p", target["player_id"])
            opts = rng.sample(era, 3) + [target]
            rng.shuffle(opts)
            return {"type": "who_am_i", "kind": "career", "season": ERA,
                    "prompt": f"Whose career is this? ({POS_LABEL[pos]}, {d.first}–{d.last} regular seasons)",
                    "clues": career_line(target),
                    "options": [{"name": c["name"]} for c in opts],
                    "max_attempts": 2,
                    "scoring": {"type": "attempts", "points": [100, 50]},
                    "reveal": {"answer": opts.index(target),
                               "hint": f"He played most of his career for the {target['team_name']}.",
                               "notes": [f"{c['position']} · {c['start']}–{c['end']}" for c in opts],
                               "fact": career_fact(d, target)}}
        return None

    # A day ------------------------------------------------------------------
    def day(self, date):
        """A drive: a fixed list of plays (everyone gets the same plays in the same
        order; how many you use depends on how the drive goes) plus the two
        point-after questions."""
        rng = random.Random(f"nfldaily-{date.isoformat()}")
        self.today = set()
        self.date = date
        kinds = rng.choices(list(PLAY_MIX), weights=list(PLAY_MIX.values()), k=PLAYS)
        seasons = rng.sample(self.d.seasons, min(PLAYS, len(self.d.seasons)))
        seasons += rng.choices(self.d.seasons, k=PLAYS - len(seasons))
        make = {
            "head_to_head": self.head_to_head,
            "odd_one_out": self.odd_one_out,
            "guess_number": self.guess_number,
            "rank_four": self.rank_four,
            "who_am_i": self.who_am_i,
        }
        rounds = []
        for kind, season in zip(kinds, seasons):
            r = None
            for k in [kind] + [k for k in make if k != kind]:
                try:
                    r = make[k](rng, season)
                    break
                except RuntimeError:
                    continue
            if r is None:
                raise RuntimeError(f"no question left for {season}")
            r["role"] = "play"
            r["call"] = CALLS[r["type"]]
            rounds.append(r)
        def first_of(makers):
            for _ in range(20):
                season = rng.choice(self.d.seasons)
                for m in makers:
                    try:
                        r = m(rng, season)
                    except RuntimeError:
                        r = None
                    if r:
                        return r
            raise RuntimeError("no point-after question left")

        # Single-answer questions only, so the try is one guess.
        pat1 = first_of([self.h2h_teams, self.h2h_players, self.odd_one_out])
        pat1.update(role="pat1", call="Extra point")
        pat2 = first_of([self.odd_one_out, self.h2h_players, self.h2h_teams])
        pat2.update(role="pat2", call="Two-point try")
        rounds += [pat1, pat2]
        return {"date": date.isoformat(), "number": (date - LAUNCH).days + 1, "format": "drive", "rounds": rounds}


STATE = OUT / "state.json"  # every question key used so far, so new days never repeat old ones


def load_state():
    """{key: date used}. Older state files hold bare keys; treat those as used at launch."""
    if not STATE.exists():
        return {}
    out = {}
    for entry in json.loads(STATE.read_text())["used"]:
        if isinstance(entry[0], str) and len(entry[0]) == 10 and entry[0][4] == "-":
            out[tuple(entry[1:])] = dt.date.fromisoformat(entry[0])
        else:
            out[tuple(entry)] = LAUNCH
    return out


def write_day(gen, date):
    (OUT / f"{date.isoformat()}.json").write_text(
        json.dumps(gen.day(date), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--through", help="generate puzzles up to this date (default: 365 days from today)")
    ap.add_argument("--from", dest="from_date",
                    help="regenerate every day from this date on (use for days no one has played yet)")
    ap.add_argument("--rebuild", action="store_true",
                    help="DANGER: regenerate every day from launch, changing past puzzles")
    args = ap.parse_args()
    through = dt.date.fromisoformat(args.through) if args.through else dt.date.today() + dt.timedelta(days=365)

    gen = Generator(Data())
    OUT.mkdir(parents=True, exist_ok=True)
    existing = sorted(dt.date.fromisoformat(f.stem) for f in OUT.glob("20??-??-??.json"))

    if args.rebuild or not existing:
        for old in OUT.glob("20??-??-??.json"):
            old.unlink()
        last = LAUNCH - dt.timedelta(days=1)
    elif args.from_date:
        start = dt.date.fromisoformat(args.from_date)
        for old in OUT.glob("20??-??-??.json"):
            if dt.date.fromisoformat(old.stem) >= start:
                old.unlink()
        last = start - dt.timedelta(days=1)
        # Keep every question ever used off-limits, including the replaced days'.
        gen.used = load_state()
    else:
        last = existing[-1]
        if STATE.exists():
            gen.used = load_state()
        else:
            # Rebuild the used set by replaying history in memory (files are left untouched).
            d = LAUNCH
            while d <= last:
                gen.day(d)
                d += dt.timedelta(days=1)

    added = 0
    d = last + dt.timedelta(days=1)
    while d <= through:
        write_day(gen, d)
        added += 1
        d += dt.timedelta(days=1)
    last = max(last, through) if added else last

    (OUT / "index.json").write_text(json.dumps(
        {"launch": LAUNCH.isoformat(), "last": last.isoformat()}, indent=1) + "\n", encoding="utf-8")
    STATE.write_text(json.dumps({"used": sorted([d.isoformat(), *k] for k, d in gen.used.items())},
                                separators=(",", ":")) + "\n")
    print(f"added {added} puzzles; puzzles now run {LAUNCH} .. {last}")


if __name__ == "__main__":
    main()
