#!/usr/bin/env python3
"""Build data/nfl.sqlite from nflverse open data.

Downloads (and caches in data/raw/) the nflverse game results and team
metadata, then derives one row per team per completed season with record,
points, ranks and playoff results. Re-run any time to refresh.

Usage: python3 scripts/build_db.py [--refresh]
"""
import csv
import sqlite3
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
DB = ROOT / "data" / "nfl.sqlite"

SOURCES = {
    "games.csv": "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv",
    "teams.csv": "https://raw.githubusercontent.com/nflverse/nfldata/master/data/teams.csv",
    "teams_colors_logos.csv": "https://github.com/nflverse/nflverse-data/releases/download/teams/teams_colors_logos.csv",
}

# Relocated teams -> current franchise code.
FRANCHISE = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA"}

ROUND_ORDER = {"WC": 1, "DIV": 2, "CON": 3, "SB": 4}
PLAYOFF_EXIT = {"WC": "lost in the Wild Card round", "DIV": "lost in the Divisional round",
                "CON": "lost in the conference championship", "SB": "lost the Super Bowl"}


def fetch(refresh: bool) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    for name, url in SOURCES.items():
        path = RAW / name
        if path.exists() and not refresh:
            continue
        print(f"downloading {name}")
        urllib.request.urlretrieve(url, path)


def read(name):
    with open(RAW / name, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main() -> None:
    fetch("--refresh" in sys.argv)
    games = read("games.csv")
    teams_by_season = read("teams.csv")
    meta = {r["team_abbr"]: r for r in read("teams_colors_logos.csv")}

    # Only seasons whose regular season is fully played.
    reg_by_season = defaultdict(list)
    for g in games:
        if g["game_type"] == "REG":
            reg_by_season[int(g["season"])].append(g)
    complete = sorted(s for s, gs in reg_by_season.items()
                      if all(g["home_score"] != "" for g in gs))
    complete_set = set(complete)

    # Season-accurate team names (nflverse table starts in 2002; reuse 2002 for earlier years).
    names = {}
    for r in teams_by_season:
        names[(int(r["season"]), r["team"])] = r["full"].replace("St Louis", "St. Louis")

    def full_name(season, team):
        return names.get((season, team)) or names.get((max(season, 2002), team)) or meta[team]["team_name"]

    con = sqlite3.connect(DB.with_suffix(".tmp"))
    cur = con.cursor()
    cur.executescript("""
    DROP TABLE IF EXISTS franchises; DROP TABLE IF EXISTS games; DROP TABLE IF EXISTS team_seasons;
    CREATE TABLE franchises (
        franchise TEXT PRIMARY KEY, name TEXT, nickname TEXT, conference TEXT,
        division TEXT, color TEXT, color2 TEXT);
    CREATE TABLE games (
        game_id TEXT PRIMARY KEY, season INT, game_type TEXT, week INT, gameday TEXT,
        away_team TEXT, away_score INT, home_team TEXT, home_score INT, overtime INT);
    CREATE TABLE team_seasons (
        season INT, team TEXT, franchise TEXT, name TEXT, nickname TEXT,
        conference TEXT, division TEXT,
        games INT, wins INT, losses INT, ties INT, win_pct REAL, record TEXT,
        points_for INT, points_against INT, point_diff INT,
        pf_rank INT, pa_rank INT, wins_rank INT,
        division_rank INT, made_playoffs INT, playoff_wins INT,
        playoff_exit TEXT, won_super_bowl INT, lost_super_bowl INT,
        start_record TEXT, longest_win_streak INT, longest_loss_streak INT,
        PRIMARY KEY (season, team));
    """)

    for code in sorted({FRANCHISE.get(t, t) for t in meta}):
        m = meta[code]
        cur.execute("INSERT INTO franchises VALUES (?,?,?,?,?,?,?)",
                    (code, m["team_name"], m["team_nick"], m["team_conf"],
                     m["team_division"], m["team_color"], m["team_color2"]))

    stats = {}
    for g in games:
        season = int(g["season"])
        if season not in complete_set:
            continue
        if g["home_score"] == "":
            continue  # unplayed (in-progress postseason)
        hs, as_ = int(g["home_score"]), int(g["away_score"])
        cur.execute("INSERT INTO games VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (g["game_id"], season, g["game_type"], int(g["week"]), g["gameday"],
                     g["away_team"], as_, g["home_team"], hs, int(g["overtime"] or 0)))
        for team, pf, pa in ((g["home_team"], hs, as_), (g["away_team"], as_, hs)):
            s = stats.setdefault((season, team), {
                "w": 0, "l": 0, "t": 0, "pf": 0, "pa": 0, "results": [],
                "po_wins": 0, "po_last": None, "po_last_won": False})
            res = "W" if pf > pa else "L" if pf < pa else "T"
            if g["game_type"] == "REG":
                s["w"] += res == "W"; s["l"] += res == "L"; s["t"] += res == "T"
                s["pf"] += pf; s["pa"] += pa
                s["results"].append((int(g["week"]), res))
            else:
                s["po_wins"] += res == "W"
                if s["po_last"] is None or ROUND_ORDER[g["game_type"]] >= ROUND_ORDER[s["po_last"]]:
                    s["po_last"], s["po_last_won"] = g["game_type"], res == "W"

    def rec(w, l, t):
        return f"{w}-{l}" + (f"-{t}" if t else "")

    def streak(results, kind):
        best = cur_ = 0
        for _, r in results:
            cur_ = cur_ + 1 if r == kind else 0
            best = max(best, cur_)
        return best

    rows = []
    for (season, team), s in stats.items():
        fr = FRANCHISE.get(team, team)
        m = meta[fr]
        results = sorted(s["results"])
        first8 = [r for _, r in results[:8]]
        n = s["w"] + s["l"] + s["t"]
        exit_ = None
        if s["po_last"]:
            won_sb = s["po_last"] == "SB" and s["po_last_won"]
            exit_ = "won the Super Bowl" if won_sb else PLAYOFF_EXIT[s["po_last"]]
        rows.append(dict(
            season=season, team=team, franchise=fr, name=full_name(season, team),
            nickname=full_name(season, team).split()[-1] if season >= 2002 else m["team_nick"],
            conference=m["team_conf"] if season >= 2002 else None,
            division=m["team_division"] if season >= 2002 else None,
            games=n, wins=s["w"], losses=s["l"], ties=s["t"],
            win_pct=round((s["w"] + 0.5 * s["t"]) / n, 4), record=rec(s["w"], s["l"], s["t"]),
            points_for=s["pf"], points_against=s["pa"], point_diff=s["pf"] - s["pa"],
            made_playoffs=int(s["po_last"] is not None), playoff_wins=s["po_wins"],
            playoff_exit=exit_,
            won_super_bowl=int(s["po_last"] == "SB" and s["po_last_won"]),
            lost_super_bowl=int(s["po_last"] == "SB" and not s["po_last_won"]),
            start_record=rec(first8.count("W"), first8.count("L"), first8.count("T")),
            longest_win_streak=streak(results, "W"), longest_loss_streak=streak(results, "L"),
        ))

    # Ranks within each season (1 = best; ties share a rank).
    by_season = defaultdict(list)
    for r in rows:
        by_season[r["season"]].append(r)

    def rank(group, key, reverse, field):
        vals = sorted((r[key] for r in group), reverse=reverse)
        for r in group:
            r[field] = vals.index(r[key]) + 1

    for group in by_season.values():
        rank(group, "points_for", True, "pf_rank")
        rank(group, "points_against", False, "pa_rank")
        rank(group, "win_pct", True, "wins_rank")
        divs = defaultdict(list)
        for r in group:
            divs[r["division"]].append(r)
        for d, members in divs.items():
            if d is None:
                for r in members:
                    r["division_rank"] = None
            else:
                rank(members, "win_pct", True, "division_rank")

    cols = [c[1] for c in cur.execute("PRAGMA table_info(team_seasons)")]
    cur.executemany(f"INSERT INTO team_seasons VALUES ({','.join('?' * len(cols))})",
                    [[r[c] for c in cols] for r in rows])
    con.commit()
    con.execute("VACUUM")
    con.close()
    DB.with_suffix(".tmp").replace(DB)
    print(f"built {DB.relative_to(ROOT)}: {len(rows)} team-seasons, seasons {complete[0]}-{complete[-1]}")


if __name__ == "__main__":
    main()
