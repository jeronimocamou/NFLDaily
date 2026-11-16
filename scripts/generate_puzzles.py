#!/usr/bin/env python3
"""Generate daily puzzle files from data/nfl.sqlite.

Each day has 5 rounds, each from a different season:
  1. head_to_head  - which of two teams had the better record, or which of
                     two players had the bigger stat (close calls only)
  2. odd_one_out   - pick the team that doesn't belong (playoffs-based)
  3. guess_number  - guess a team's wins/points or a player's stat
  4. rank_four     - order a division, 4 teams, or 4 players
  5. who_am_i      - name the player from a stat line (2 tries, hint after a miss)

Every round has public fields (sent to the browser before answering) and a
`reveal` object (answer, notes, fact) that only the API sends back after a
guess. Output goes to puzzles/ at the repo root, which is NOT served
statically, so answers and future puzzles stay private.

Generation is deterministic: the same start date and day count always give
the same puzzles, and no question repeats inside a generated range.

Usage: python3 scripts/generate_puzzles.py [--days 380]
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
    "points_for": dict(min=150, max=650, step=1, bump=5, scoring={"type": "linear", "exact": 10, "zero_at": 110}),
    "passing_yards": dict(min=2000, max=5600, step=25, bump=100, scoring={"type": "linear", "exact": 100, "zero_at": 1000}),
    "passing_tds": dict(min=5, max=60, step=1, bump=1, scoring={"type": "linear", "exact": 1, "zero_at": 12}),
    "rushing_yards": dict(min=500, max=2200, step=10, bump=50, scoring={"type": "linear", "exact": 50, "zero_at": 650}),
    "receiving_yards": dict(min=600, max=2000, step=10, bump=50, scoring={"type": "linear", "exact": 50, "zero_at": 650}),
    "receptions": dict(min=40, max=150, step=1, bump=1, scoring={"type": "linear", "exact": 3, "zero_at": 35}),
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
        self.used = set()

    def fresh(self, key):
        if key in self.used:
            return False
        self.used.add(key)
        return True

    # Round 1 ----------------------------------------------------------------
    def head_to_head(self, rng, season):
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
        teams = self.d.by_season[season]
        playoff = [t for t in teams if t["made_playoffs"]]
        missed = [t for t in teams if not t["made_playoffs"]]

        def unused(pool):
            return [t for t in pool if ("ooo", season, t["team"]) not in self.used]

        for _ in range(500):
            if rng.random() < 0.6:
                odd = rng.choice(unused([t for t in missed if t["wins"] >= 8]) or unused(missed) or missed)
                others = rng.sample(playoff, 3)
                prompt = f"Which of these teams did NOT make the {season} playoffs?"
            else:
                odd = rng.choice(unused([t for t in playoff if t["wins"] <= 11]) or unused(playoff) or playoff)
                others = rng.sample([t for t in missed if t["wins"] >= 6] or missed, 3)
                prompt = f"Only one of these teams made the {season} playoffs. Which one?"
            if not self.fresh(("ooo", season, odd["team"])):
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
        kind = rng.choice(["wins", "points_for", "player", "player"])
        if kind == "player":
            return self.guess_player(rng, season) or self.guess_team(rng, season, "wins")
        return self.guess_team(rng, season, kind)

    def guess_team(self, rng, season, metric):
        teams = self.d.by_season[season]
        for _ in range(500):
            t = rng.choice(teams)
            if not self.fresh(("gn", season, t["team"], metric)):
                continue
            g = GUESS[metric]
            if metric == "wins":
                prompt = f"How many regular-season games did the {season} {t['name']} win?"
                hint = f"They played {t['games']} games."
                lo, hi, start, label = 0, t["games"], t["games"] // 2, f"{t['wins']} wins ({t['record']})"
            else:
                avg = round(sum(x["points_for"] for x in teams) / len(teams))
                prompt = f"How many points did the {season} {t['name']} score in the regular season?"
                hint = f"League average in {season}: {avg} points."
                lo, hi, start, label = g["min"], g["max"], avg, f"{t['points_for']} points"
            return {
                "type": "guess_number", "metric": metric, "season": season, "prompt": prompt, "hint": hint,
                "subject": team_opt(t), "min": lo, "max": hi, "start": start,
                "step": g["step"], "bump": g["bump"], "scoring": g["scoring"],
                "reveal": {"answer": t[metric], "answer_label": label, "fact": team_fact(self.d, t)},
            }
        raise RuntimeError("no team guess")

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
        if rng.random() < 0.35:
            r = self.rank_players(rng, season)
            if r:
                return r
        return self.rank_teams(rng, season)

    def rank_teams(self, rng, season):
        teams = self.d.by_season[season]
        divisions = sorted({t["division"] for t in teams if t["division"]})
        for attempt in range(500):
            metric = rng.choice(["wins", "points_for"])
            key = "win_pct" if metric == "wins" else "points_for"
            if divisions and attempt < 40:
                div = rng.choice(divisions)
                members = [t for t in teams if t["division"] == div]
                group = f"the {season} {div}"
                dedup = ("r4", season, div, metric)
            else:
                members = rng.sample(teams, 4)
                vals = sorted(t[key] * (t["games"] if key == "win_pct" else 1) for t in members)
                min_gap = 1 if metric == "wins" else 15
                if any(b - a < min_gap for a, b in zip(vals, vals[1:])):
                    continue
                group = f"these {season} teams"
                dedup = ("r4", season, *sorted(t["team"] for t in members), metric)
            if len({t[key] for t in members}) < 4 or not self.fresh(dedup):
                continue
            ordered = sorted(members, key=lambda t: t[key], reverse=True)
            shown = members[:]
            rng.shuffle(shown)
            label = "regular-season record" if metric == "wins" else "points scored"
            return {
                "type": "rank_four", "kind": "team", "season": season,
                "prompt": f"Rank {group} by {label}, best first.",
                "options": [team_opt(t) for t in shown],
                "reveal": {"answer": [shown.index(t) for t in ordered],
                           "notes": [t["record"] if metric == "wins" else f"{t['points_for']} pts" for t in shown],
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
        pos = rng.choice(["QB", "QB", "RB", "WR"])
        stat = {"QB": "passing_yards", "RB": "rushing_yards", "WR": "receiving_yards"}[pos]
        pool = [p for p in self.d.notable(season, stat) if p["position"] == pos]
        if pos == "QB":
            pool = [p for p in pool if p["attempts"] >= 350]
        if len(pool) < 4:
            pool = [p for p in self.d.players_by_season[season] if p["position"] == pos]
            pool = sorted(pool, key=lambda p: -p[stat])[:12]
        rng.shuffle(pool)
        for target in pool:
            if not self.fresh(("who", target["player_id"], season)):
                continue
            others = rng.sample([p for p in pool if p is not target], 3)
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

    # A day ------------------------------------------------------------------
    def day(self, date):
        rng = random.Random(f"nfldaily-{date.isoformat()}")
        r4_season = rng.choice([s for s in self.d.seasons if s >= 2002])  # current divisions
        rest = rng.sample([s for s in self.d.seasons if s != r4_season], 4)
        rounds = [
            self.head_to_head(rng, rest[0]),
            self.odd_one_out(rng, rest[1]),
            self.guess_number(rng, rest[2]),
            self.rank_four(rng, r4_season),
            self.who_am_i(rng, rest[3]),
        ]
        return {"date": date.isoformat(), "number": (date - LAUNCH).days + 1, "rounds": rounds}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=380)
    args = ap.parse_args()

    gen = Generator(Data())
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()
    for i in range(args.days):
        date = LAUNCH + dt.timedelta(days=i)
        (OUT / f"{date.isoformat()}.json").write_text(
            json.dumps(gen.day(date), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    last = LAUNCH + dt.timedelta(days=args.days - 1)
    (OUT / "index.json").write_text(json.dumps(
        {"launch": LAUNCH.isoformat(), "last": last.isoformat()}, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {args.days} puzzles {LAUNCH} .. {last} to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
