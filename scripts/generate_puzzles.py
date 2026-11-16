#!/usr/bin/env python3
"""Generate daily puzzle files from data/nfl.sqlite.

Each day has 5 rounds, each from a different season:
  1. better_record  - which of two teams had the better record (close pairs only)
  2. odd_one_out    - pick the team that doesn't belong (playoffs-based)
  3. guess_number   - guess a team's win total (partial credit)
  4. rank_four      - order a division by wins or points scored
  5. guess_number   - guess a team's points scored (harder)

Output: site/puzzles/YYYY-MM-DD.json and site/puzzles/index.json.
Generation is deterministic: the same start date and day count always give
the same puzzles, and no question repeats inside a generated range.

Usage: python3 scripts/generate_puzzles.py [--start 2026-11-16] [--days 365]
"""
import argparse
import datetime as dt
import json
import random
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "nfl.sqlite"
OUT = ROOT / "site" / "puzzles"
LAUNCH = dt.date(2026, 11, 16)  # Puzzle #1


class Data:
    def __init__(self):
        con = sqlite3.connect(DB)
        con.row_factory = sqlite3.Row
        self.rows = [dict(r) for r in con.execute(
            "SELECT ts.*, f.color, f.color2 FROM team_seasons ts JOIN franchises f USING (franchise)")]
        self.seasons = sorted({r["season"] for r in self.rows})
        self.by_season = {s: [r for r in self.rows if r["season"] == s] for s in self.seasons}


def team(r):
    return {"team": r["team"], "name": r["name"], "color": r["color"], "color2": r["color2"],
            "record": r["record"], "points_for": r["points_for"]}


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def fact(r):
    """One interesting sentence about a team-season."""
    n = r["name"]
    s = r["season"]
    options = []
    if r["won_super_bowl"]:
        options.append(f"The {s} {n} went {r['record']} and won the Super Bowl.")
    if r["lost_super_bowl"]:
        options.append(f"The {s} {n} went {r['record']} and reached the Super Bowl, but lost.")
    if r["start_record"] in ("0-8", "8-0", "1-7", "7-1"):
        options.append(f"The {s} {n} started the season {r['start_record']} and finished {r['record']}.")
    if r["longest_win_streak"] >= 8:
        options.append(f"The {s} {n} won {r['longest_win_streak']} games in a row on the way to {r['record']}.")
    if r["longest_loss_streak"] >= 8:
        options.append(f"The {s} {n} lost {r['longest_loss_streak']} straight games during a {r['record']} season.")
    if r["pf_rank"] == 1:
        options.append(f"The {s} {n} led the NFL with {r['points_for']} points.")
    if r["pa_rank"] == 1:
        options.append(f"The {s} {n} allowed the fewest points in the NFL ({r['points_against']}).")
    if r["wins"] >= 10 and not r["made_playoffs"]:
        options.append(f"The {s} {n} went {r['record']} and still missed the playoffs.")
    if r["made_playoffs"] and r["wins"] <= 8:
        options.append(f"The {s} {n} made the playoffs at just {r['record']}.")
    if options:
        return options[0]
    tail = f" and {r['playoff_exit']}" if r["playoff_exit"] else " and missed the playoffs"
    return (f"The {s} {n} went {r['record']}, ranked {ordinal(r['pf_rank'])} in points scored{tail}.")


class Generator:
    def __init__(self, data):
        self.d = data
        self.used = set()

    def fresh(self, key):
        if key in self.used:
            return False
        self.used.add(key)
        return True

    # -- Round types ---------------------------------------------------------
    def better_record(self, rng, season):
        teams = self.d.by_season[season]
        for _ in range(500):
            a, b = rng.sample(teams, 2)
            gap = abs(a["win_pct"] - b["win_pct"]) * a["games"]
            if not (1 <= gap <= 3):
                continue
            if not self.fresh(("br", season, *sorted((a["team"], b["team"])))):
                continue
            ans = 0 if a["win_pct"] > b["win_pct"] else 1
            better = (a, b)[ans]
            return {
                "type": "better_record",
                "season": season,
                "prompt": f"In {season}, who had the better regular-season record?",
                "options": [team(a), team(b)],
                "answer": ans,
                "fact": fact(better),
            }
        raise RuntimeError("no pair")

    def odd_one_out(self, rng, season):
        teams = self.d.by_season[season]
        playoff = [t for t in teams if t["made_playoffs"]]
        missed = [t for t in teams if not t["made_playoffs"]]
        def unused(pool):
            return [t for t in pool if ("ooo", season, t["team"]) not in self.used]

        for _ in range(500):
            if rng.random() < 0.6:
                # 3 playoff teams + 1 team that missed despite a decent record.
                tricky = unused([t for t in missed if t["wins"] >= 8]) or unused(missed) or missed
                odd = rng.choice(tricky)
                others = rng.sample(playoff, 3)
                prompt = f"Which of these teams did NOT make the {season} playoffs?"
                why = f"The {season} {odd['name']} went {odd['record']} and missed the playoffs."
            else:
                # 1 playoff team (not a juggernaut) + 3 that missed.
                odd = rng.choice(unused([t for t in playoff if t["wins"] <= 11]) or unused(playoff) or playoff)
                others = rng.sample([t for t in missed if t["wins"] >= 6] or missed, 3)
                prompt = f"Only one of these teams made the {season} playoffs. Which one?"
                exit_ = odd["playoff_exit"]
                why = f"The {season} {odd['name']} went {odd['record']} and {exit_}."
            if not self.fresh(("ooo", season, odd["team"])):
                continue
            opts = others + [odd]
            rng.shuffle(opts)
            options = []
            for t in opts:
                o = team(t)
                o["note"] = t["playoff_exit"] or "missed playoffs"
                options.append(o)
            return {
                "type": "odd_one_out",
                "season": season,
                "prompt": prompt,
                "options": options,
                "answer": opts.index(odd),
                "fact": why,
            }
        raise RuntimeError("no odd one out")

    def guess_number(self, rng, season, metric):
        teams = self.d.by_season[season]
        for _ in range(500):
            t = rng.choice(teams)
            if not self.fresh(("gn", season, t["team"], metric)):
                continue
            if metric == "wins":
                return {
                    "type": "guess_number",
                    "metric": "wins",
                    "season": season,
                    "prompt": f"How many regular-season games did the {season} {t['name']} win?",
                    "hint": f"They played {t['games']} games.",
                    "team": team(t),
                    "min": 0, "max": t["games"], "start": t["games"] // 2,
                    "answer": t["wins"],
                    "answer_label": f"{t['wins']} wins ({t['record']})",
                    # points by distance from answer: exact, 1 off, 2 off, 3 off
                    "scoring": {"type": "steps", "steps": [100, 60, 30, 10]},
                    "fact": fact(t),
                }
            avg = round(sum(x["points_for"] for x in teams) / len(teams))
            return {
                "type": "guess_number",
                "metric": "points_for",
                "season": season,
                "prompt": f"How many points did the {season} {t['name']} score in the regular season?",
                "hint": f"League average in {season}: {avg} points.",
                "team": team(t),
                "min": 150, "max": 650, "start": avg, "step": 1,
                "answer": t["points_for"],
                "answer_label": f"{t['points_for']} points",
                # full marks within `exact`, then lose 1 point per point off
                "scoring": {"type": "linear", "exact": 10, "zero_at": 110},
                "fact": fact(t),
            }
        raise RuntimeError("no guess")

    def rank_four(self, rng, season):
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
                # League-wide mix: 4 teams with clear gaps between them.
                members = rng.sample(teams, 4)
                vals = sorted(t[key] * (t["games"] if key == "win_pct" else 1) for t in members)
                min_gap = 1 if metric == "wins" else 15
                if any(b - a < min_gap for a, b in zip(vals, vals[1:])):
                    continue
                group = f"these {season} teams"
                dedup = ("r4", season, *sorted(t["team"] for t in members), metric)
            if len({t[key] for t in members}) < 4:
                continue  # needs a strict order
            if not self.fresh(dedup):
                continue
            ordered = sorted(members, key=lambda t: t[key], reverse=True)
            shown = members[:]
            rng.shuffle(shown)
            label = "regular-season record" if metric == "wins" else "points scored"
            options = []
            for t in shown:
                o = team(t)
                o["note"] = t["record"] if metric == "wins" else f"{t['points_for']} pts"
                options.append(o)
            return {
                "type": "rank_four",
                "metric": metric,
                "season": season,
                "prompt": f"Rank {group} by {label}, best first.",
                "options": options,
                "answer": [shown.index(t) for t in ordered],
                "fact": fact(ordered[0]),
            }
        raise RuntimeError("no rank four")

    # -- A day ---------------------------------------------------------------
    def day(self, date):
        rng = random.Random(f"nfldaily-{date.isoformat()}")
        # Rank four prefers 2002+ (divisions as they are today).
        r4_season = rng.choice([s for s in self.d.seasons if s >= 2002])
        rest = rng.sample([s for s in self.d.seasons if s != r4_season], 4)
        rounds = [
            self.better_record(rng, rest[0]),
            self.odd_one_out(rng, rest[1]),
            self.guess_number(rng, rest[2], "wins"),
            self.rank_four(rng, r4_season),
            self.guess_number(rng, rest[3], "points_for"),
        ]
        return {
            "date": date.isoformat(),
            "number": (date - LAUNCH).days + 1,
            "rounds": rounds,
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default=LAUNCH.isoformat())
    ap.add_argument("--days", type=int, default=365)
    args = ap.parse_args()
    start = dt.date.fromisoformat(args.start)

    gen = Generator(Data())
    OUT.mkdir(parents=True, exist_ok=True)
    for i in range(args.days):
        date = start + dt.timedelta(days=i)
        (OUT / f"{date.isoformat()}.json").write_text(
            json.dumps(gen.day(date), indent=1) + "\n", encoding="utf-8")
    last = start + dt.timedelta(days=args.days - 1)
    (OUT / "index.json").write_text(json.dumps({
        "launch": LAUNCH.isoformat(), "first": start.isoformat(), "last": last.isoformat(),
    }, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {args.days} puzzles {start} .. {last} to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
