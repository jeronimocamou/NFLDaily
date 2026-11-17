"""Open-ended "name one" plays (Krillion-style) for the daily drive.

Every question has a set of valid answers. Each answer carries a prior
"obviousness" weight (how likely a typical fan is to think of it), which the
server blends with what players actually answered to decide how rare an
answer is: rarer right answers gain more yards.

Answers are ids: a player's gsis id, or a franchise code (OAK/SD/STL map to
the current franchise). The browser autocompletes from site/names.json, which
lists every player and team, so the list doesn't give answers away.
"""

MAX_PER_KIND = 3  # at most this many of one question type per drive
NAME_REUSE_DAYS = 240  # the exact same question doesn't come back for ~8 months
TOPIC_REUSE_DAYS = 21  # nor the same team + stat in another era/threshold within 3 weeks


def fmt(n):
    return f"{n:,}"


POS_WORD = {"QB": "QB", "RB": "running back", "WR": "receiver", "TE": "tight end"}

# (position(s), stat, label, thresholds) for "Name a ___ who ___ in <season>"
SEASON_LISTS = [
    (("QB",), "passing_yards", "threw for {t}+ yards", [4000, 4500]),
    (("QB",), "passing_tds", "threw {t}+ touchdown passes", [30, 35]),
    (("RB",), "rushing_yards", "ran for {t}+ yards", [1200, 1400]),
    (("RB",), "rushing_tds", "ran for {t}+ touchdowns", [12, 15]),
    (("WR", "TE"), "receiving_yards", "had {t}+ receiving yards", [1200, 1400]),
    (("WR", "TE"), "receptions", "caught {t}+ passes", [90, 100]),
    (("WR", "TE"), "receiving_tds", "caught {t}+ touchdown passes", [10, 12]),
    (("TE",), "receiving_yards", "had {t}+ receiving yards", [900]),
    (("QB",), "interceptions", "threw {t}+ interceptions", [15, 18]),
    (("QB",), "rushing_yards", "ran for {t}+ yards", [400, 600]),
    (("RB",), "receptions", "caught {t}+ passes", [50, 60]),
    (("RB",), "receiving_yards", "had {t}+ receiving yards", [500]),
]
UNIT = {"passing_yards": "yds", "rushing_yards": "yds", "receiving_yards": "yds", "receptions": "catches", "interceptions": "INT"}
# Single-season feats across the whole era: few answers, so deep shots.
ERA_FEATS = [
    (("QB",), "passing_tds", "threw {t}+ touchdown passes in a season", [40, 45]),
    (("QB",), "passing_yards", "threw for {t}+ yards in a season", [5000]),
    (("RB",), "rushing_yards", "ran for {t}+ yards in a season", [1800, 2000]),
    (("RB",), "rushing_tds", "ran for {t}+ touchdowns in a season", [20]),
    (("WR", "TE"), "receiving_yards", "had {t}+ receiving yards in a season", [1700]),
    (("WR", "TE"), "receptions", "caught {t}+ passes in a season", [125]),
    (("WR", "TE"), "receiving_tds", "caught {t}+ touchdown passes in a season", [16]),
]
CAREER_LISTS = [
    (("QB",), "passing_yards", "has {t}+ career passing yards", [25000, 30000, 35000, 40000]),
    (("QB",), "passing_tds", "has {t}+ career touchdown passes", [150, 200, 250]),
    (("RB",), "rushing_yards", "has {t}+ career rushing yards", [6000, 7000, 8000, 9000]),
    (("RB",), "rushing_tds", "has {t}+ career rushing touchdowns", [50, 60, 70]),
    (("WR", "TE"), "receiving_yards", "has {t}+ career receiving yards", [7000, 8000, 9000, 10000]),
    (("WR", "TE"), "receptions", "has {t}+ career catches", [500, 600, 700]),
    (("WR", "TE"), "receiving_tds", "has {t}+ career touchdown catches", [40, 50, 60]),
    (("TE",), "receiving_yards", "has {t}+ career receiving yards", [4000, 5000]),
    (("TE",), "receptions", "has {t}+ career catches", [350, 450]),
]
# Single-season feats over a whole span of years: lots of right answers.
SPAN_FEATS = [
    (("QB",), "passing_yards", "threw for {t}+ yards in a season", [4000, 3500]),
    (("QB",), "passing_tds", "threw {t}+ touchdown passes in a season", [30, 25]),
    (("RB",), "rushing_yards", "ran for {t}+ yards in a season", [1200, 1000]),
    (("RB",), "rushing_tds", "ran for {t}+ touchdowns in a season", [12, 10]),
    (("WR", "TE"), "receiving_yards", "had {t}+ receiving yards in a season", [1200, 1000]),
    (("WR", "TE"), "receptions", "caught {t}+ passes in a season", [90, 80]),
    (("WR", "TE"), "receiving_tds", "caught {t}+ touchdown passes in a season", [10, 8]),
    (("TE",), "receiving_yards", "had {t}+ receiving yards in a season", [800, 700]),
]
DECADES = [(1999, 2025, "since 1999"), (2000, 2009, "in the 2000s"), (2010, 2019, "in the 2010s"), (2020, 2025, "in the 2020s")]
# Eras for team questions. Recent eras are the easiest for most fans.
TEAM_ERAS = DECADES + [(2010, 2025, "since 2010"), (2015, 2025, "since 2015")]


def era_chip(lo, hi):
    """The little label on the question card."""
    if hi < 2025:
        return f"{lo}s"
    return "2020s" if lo == 2020 else f"Since {lo}"


def who_word(positions):
    return "QB" if positions == ("QB",) else "running back" if positions == ("RB",) else "tight end" if positions == ("TE",) else "player"


class NameOneMixin:
    """Mixed into the Generator in generate_puzzles.py."""

    def fresh_topic(self, key, topic):
        """fresh() for the exact question, plus no question on the same topic
        (team + stat in any era or threshold) in the last TOPIC_REUSE_DAYS."""
        last = self.used.get(topic)
        if last is not None and (self.date - last).days < TOPIC_REUSE_DAYS and not getattr(self, "relax", None):
            return False
        if not self.fresh(key, NAME_REUSE_DAYS):
            return False
        self.used[topic] = self.date
        return True

    # ---- answer helpers -------------------------------------------------------------
    def player_weight(self, pid):
        c = self.d.career_by_id.get(pid)
        if not c:
            return 0.3
        fame = max(c["passing_yards"] / 3, c["rushing_yards"], c["receiving_yards"])
        return (fame / 1000 + 1) ** 1.5

    def franchise_weight(self, code):
        f = self.d.franchise_by_code[code]
        return 1 + 2 * f["sb_wins"] + f["playoff_apps"] / 4

    def player_answers(self, items):
        """items: [(player_id, name, note)] -> valid dict + "obviousness" priors.
        A player who fits the question several times (e.g. five 1,000-yard
        seasons) is a more obvious answer than one who fits it once."""
        valid, prior, times = {}, {}, {}
        for pid, name, note in items:
            if pid in valid:
                valid[pid]["note"] += f", {note}"
                times[pid] += 1
                continue
            valid[pid] = {"name": name, "note": note}
            times[pid] = 1
        for pid in valid:
            prior[pid] = round(self.player_weight(pid) * (1 + 0.6 * (times[pid] - 1)), 2)
        return valid, prior

    def name_one(self, role, season, prompt, kind, valid, prior, fact, hint=None, clues=None):
        n = len(valid)
        return {
            "type": "name_one",
            "answer_kind": kind,  # player | team
            "season": season,
            "prompt": prompt,
            "hint": hint or (f"There {'is' if n == 1 else 'are'} {n} right answer{'' if n == 1 else 's'}."),
            **({"clues": clues} if clues else {}),
            "answers": n,
            "reveal": {"valid": valid, "prior": prior, "fact": fact},
        }

    # ---- passes: lots of right answers -------------------------------------------------
    def pass_season_list(self, rng, season):
        for _ in range(60):
            pos, stat, label, ts = rng.choice(SEASON_LISTS)
            t = rng.choice(ts)
            hits = sorted((p for p in self.d.players_by_season[season] if p["position"] in pos and p[stat] >= t),
                          key=lambda p: -p[stat])
            if not 3 <= len(hits) <= 16 or not self.fresh(("n1s", season, stat, "".join(pos), t), NAME_REUSE_DAYS):
                continue
            unit = UNIT.get(stat, "TD")
            valid, prior = self.player_answers((p["player_id"], p["name"], f"{fmt(p[stat])} {unit}, {p['team_name']}") for p in hits)
            top = hits[0]
            prompt = f"Name a {who_word(pos)} who {label.format(t=fmt(t))} in {season}."
            fact = f"{top['name']} led this list with {fmt(top[stat])} for the {top['team_name']}."
            return self.name_one("pass", season, prompt, "player", valid, prior, fact)
        return None

    def pass_team_list(self, rng, season):
        teams = self.d.by_season[season]
        divs = {}
        for t in teams:
            if t["division_rank"] == 1:
                divs[t["division"]] = divs.get(t["division"], 0) + 1
        clean_divs = season >= 2002 and all(n == 1 for n in divs.values())
        options = [
            *([("won its division", lambda t: t["division_rank"] == 1)] if clean_divs else []),
            ("made the playoffs", lambda t: t["made_playoffs"]),
            ("won 11 or more games", lambda t: t["wins"] >= 11),
            ("finished with a losing record", lambda t: t["wins"] < t["losses"]),
        ]
        rng.shuffle(options)
        for label, test in options:
            hits = [t for t in teams if test(t)]
            if not 3 <= len(hits) <= 16 or not self.fresh(("n1t", season, label), NAME_REUSE_DAYS):
                continue
            valid = {t["franchise"]: {"name": t["name"], "note": f"{t['record']}" + (f", {t['playoff_exit']}" if t["playoff_exit"] else "")} for t in hits}
            prior = {t["franchise"]: round(self.franchise_weight(t["franchise"]) + t["wins"] / 3, 2) for t in hits}
            best = max(hits, key=lambda t: t["win_pct"])
            fact = f"The {best['name']} had the best record of these at {best['record']}."
            return self.name_one("pass", season, f"Name a team that {label} in {season}.", "team", valid, prior, fact)
        return None

    def pass_franchise_qbs(self, rng):
        for _ in range(60):
            f = rng.choice(self.d.franchises)
            lo, hi, when = rng.choice(TEAM_ERAS)
            rows = self._cached(("qbs", f["franchise"], lo, hi), lambda: [r for r in self.d.qb_starts if r["franchise"] == f["franchise"] and lo <= r["season"] <= hi])
            by = {}
            for r in rows:
                b = by.setdefault(r["player_id"], {"name": r["name"], "starts": 0, "first": r["season"], "last": r["season"]})
                b["starts"] += r["starts"]
                b["first"], b["last"] = min(b["first"], r["season"]), max(b["last"], r["season"])
            if not 8 <= len(by) <= 45 or not self.fresh_topic(("n1q", f["franchise"], lo, hi), ("tq", f["franchise"])):
                continue
            items = [(pid, b["name"], f"{b['starts']} start{'s' if b['starts'] != 1 else ''} ({b['first']}{'' if b['first'] == b['last'] else '–' + str(b['last'])})")
                     for pid, b in sorted(by.items(), key=lambda kv: -kv[1]["starts"])]
            valid, prior = self.player_answers(items)
            # Starts matter more than fame here: the regular starter is the obvious answer.
            for pid, b in by.items():
                prior[pid] = round(prior[pid] * 0.3 + b["starts"] / 4, 2)
            top_id = max(by, key=lambda k: by[k]["starts"])
            fact = (f"{len(by)} different quarterbacks started for the {f['name']} {when}. "
                    f"{by[top_id]['name']} started the most ({by[top_id]['starts']}).")
            season = era_chip(lo, hi)
            return self.name_one("pass", season, f"Name a QB who started a game for the {f['name']} {when}.", "player", valid, prior, fact)
        return None

    def pass_franchise_1000(self, rng):
        for _ in range(60):
            f = rng.choice(self.d.franchises)
            stat, word = rng.choice([("rushing_yards", "ran for"), ("receiving_yards", "had")])
            tail = "yards" if stat == "rushing_yards" else "receiving yards"
            t = rng.choice([1000, 800])
            lo, hi, when = rng.choice(TEAM_ERAS)
            hits = self._cached(("k", f["franchise"], stat, t, lo, hi), lambda: [
                p for p in self.d.players if p["franchise"] == f["franchise"] and p[stat] >= t and lo <= p["season"] <= hi])
            ids = {p["player_id"] for p in hits}
            if not 8 <= len(ids) <= 30 or not self.fresh_topic(("n1k", f["franchise"], stat, t, lo, hi), ("tk", f["franchise"], stat)):
                continue
            items = [(p["player_id"], p["name"], f"{fmt(p[stat])} in {p['season']}") for p in sorted(hits, key=lambda p: p["season"])]
            valid, prior = self.player_answers(items)
            best = max(hits, key=lambda p: p[stat])
            fact = f"The best of these seasons: {best['name']} with {fmt(best[stat])} {tail} in {best['season']}."
            prompt = f"Name a player who {word} {fmt(t)}+ {tail} in a season for the {f['name']} {when}."
            return self.name_one("pass", era_chip(lo, hi), prompt, "player", valid, prior, fact)
        return None

    def pass_career_list(self, rng):
        for _ in range(60):
            pos, stat, label, ts = rng.choice(CAREER_LISTS)
            t = rng.choice(ts)
            hits = sorted((c for c in self.d.careers if c["position"] in pos and c[stat] >= t), key=lambda c: -c[stat])
            if not 12 <= len(hits) <= 60 or not self.fresh(("n1c", stat, "".join(pos), t), NAME_REUSE_DAYS):
                continue
            unit = "catches" if stat == "receptions" else "TD" if stat.endswith("tds") else "yds"
            valid, prior = self.player_answers((c["player_id"], c["name"], f"{fmt(c[stat])} {unit} ({c['start']}–{c['end']})") for c in hits)
            fact = f"{hits[0]['name']} tops this list with {fmt(hits[0][stat])}. Totals count regular seasons from 1999 on."
            return self.name_one("pass", "Since 1999", f"Name a {who_word(pos)} who {label.format(t=fmt(t))} since 1999.", "player", valid, prior, fact)
        return None

    def pass_franchise_list(self, rng):
        options = [
            ("won a Super Bowl since 1999", lambda f: f["sb_wins"] > 0),
            ("reached a Super Bowl since 1999", lambda f: f["sb_apps"] > 0),
            ("has NOT reached a Super Bowl since 1999", lambda f: f["sb_apps"] == 0),
            ("made the playoffs at least 12 times since 1999", lambda f: f["playoff_apps"] >= 12),
        ]
        rng.shuffle(options)
        for label, test in options:
            hits = [f for f in self.d.franchises if test(f)]
            if not 3 <= len(hits) <= 20 or not self.fresh(("n1f", label), NAME_REUSE_DAYS):
                continue
            valid = {f["franchise"]: {"name": f["name"], "note": f"{f['sb_wins']} titles, {f['sb_apps']} Super Bowls, {f['playoff_apps']} playoff trips"} for f in hits}
            prior = {f["franchise"]: round(self.franchise_weight(f["franchise"]), 2) for f in hits}
            return self.name_one("pass", "Since 1999", f"Name a franchise that {label}.", "team", valid, prior,
                                 f"{len(hits)} of the 32 franchises fit.")
        return None

    def pass_play(self, rng, season):
        r = self._pass_play(rng, season)
        if r is None:
            # Running low: let older questions come back sooner rather than fail.
            self.relax = 10
            try:
                r = self._pass_play(rng, season)
            finally:
                self.relax = None
        return r

    def _pass_play(self, rng, season):
        makers = [
            (lambda: self.pass_season_list(rng, season), 3),
            (lambda: self.pass_team_list(rng, season), 1),
            (lambda: self.pass_franchise_qbs(rng), 3),
            (lambda: self.pass_franchise_1000(rng), 3),
            (lambda: self.pass_career_list(rng), 2),
            (lambda: self.pass_franchise_list(rng), 1),
        ]
        order = rng.choices(range(len(makers)), weights=[w for _, w in makers], k=len(makers) * 2)
        for i in order + list(range(len(makers))):
            r = makers[i][0]()
            if r:
                return r
        return None

    # ---- deep shots: few right answers, or one ----------------------------------------
    def deep_whose_season(self, rng, season):
        pos = rng.choice(["QB", "QB", "RB", "WR"])
        stat = {"QB": "passing_yards", "RB": "rushing_yards", "WR": "receiving_yards"}[pos]
        mins = {"QB": 3500, "RB": 1100, "WR": 1100}
        pool = [p for p in self.d.players_by_season[season] if p["position"] == pos and p[stat] >= mins[pos]]
        rng.shuffle(pool)
        for p in pool:
            if ("p", p["player_id"]) in self.today or not self.fresh(("dws", p["player_id"], season)):
                continue
            self.today.add(("p", p["player_id"]))
            return self.name_one("deep", season, f"Whose {season} season is this? ({POS_WORD[pos]})", "player",
                                 {p["player_id"]: {"name": p["name"], "note": p["team_name"]}}, {p["player_id"]: 1},
                                 self.player_fact(p), hint="Type his name.", clues=self.player_line(p))
        return None

    def deep_whose_career(self, rng):
        pos = rng.choice(["QB", "RB", "WR"])
        stat = {"QB": "passing_yards", "RB": "rushing_yards", "WR": "receiving_yards"}[pos]
        mins = {"QB": 20000, "RB": 5000, "WR": 6000}
        pool = [c for c in self.d.careers if c["position"] == pos and c[stat] >= mins[pos]]
        rng.shuffle(pool)
        for c in pool:
            if ("p", c["player_id"]) in self.today or not self.fresh(("dwc", c["player_id"])):
                continue
            self.today.add(("p", c["player_id"]))
            return self.name_one("deep", "Since 1999", f"Whose career is this? ({POS_WORD[pos]}, 1999–2025 regular seasons)", "player",
                                 {c["player_id"]: {"name": c["name"], "note": f"{c['start']}–{c['end']}"}}, {c["player_id"]: 1},
                                 self.career_fact(c), hint="Type his name.", clues=self.career_line(c))
        return None

    def deep_era_feat(self, rng):
        for _ in range(60):
            pos, stat, label, ts = rng.choice(ERA_FEATS)
            t = rng.choice(ts)
            hits = sorted((p for p in self.d.players if p["position"] in pos and p[stat] >= t), key=lambda p: -p[stat])
            ids = {p["player_id"] for p in hits}
            if not 2 <= len(ids) <= 12 or not self.fresh(("dfe", stat, "".join(pos), t), NAME_REUSE_DAYS):
                continue
            unit = UNIT.get(stat, "TD")
            valid, prior = self.player_answers((p["player_id"], p["name"], f"{fmt(p[stat])} {unit} in {p['season']}") for p in hits)
            top = hits[0]
            fact = f"The best: {top['name']} with {fmt(top[stat])} in {top['season']}."
            return self.name_one("deep", "Since 1999", f"Name a {who_word(pos)} who {label.format(t=fmt(t))} since 1999.", "player", valid, prior, fact)
        return None

    def deep_play(self, rng, season):
        r = self._deep_play(rng, season)
        if r is None:
            self.relax = 10
            try:
                r = self._deep_play(rng, season)
            finally:
                self.relax = None
        return r

    def deep_leader(self, rng, season):
        options = [("passing_yards", ("QB",), "passing yards"), ("passing_tds", ("QB",), "touchdown passes"),
                   ("rushing_yards", ("RB",), "rushing yards"), ("receiving_yards", ("WR", "TE", "RB"), "receiving yards"),
                   ("receptions", ("WR", "TE", "RB"), "receptions")]
        rng.shuffle(options)
        for stat, pos, label in options:
            pool = [p for p in self.d.players_by_season[season] if p["position"] in pos]
            if not pool:
                continue
            best = max(p[stat] for p in pool)
            leaders = [p for p in pool if p[stat] == best]
            if not self.fresh(("dld", season, stat)):
                continue
            unit = UNIT.get(stat, "TD")
            valid, prior = self.player_answers((p["player_id"], p["name"], f"{fmt(p[stat])} {unit}, {p['team_name']}") for p in leaders)
            return self.name_one("deep", season, f"Who led the NFL in {label} in {season}?", "player", valid, prior,
                                 self.player_fact(leaders[0]), hint="Type his name." if len(leaders) == 1 else None)
        return None

    def deep_team_qbs(self, rng, season):
        teams = list(self.d.by_season[season])
        rng.shuffle(teams)
        for t in teams:
            rows = [r for r in self.d.qb_starts if r["season"] == season and r["team"] == t["team"]]
            if not 2 <= len(rows) <= 5 or not self.fresh(("dtq", season, t["team"])):
                continue
            rows.sort(key=lambda r: -r["starts"])
            valid, prior = self.player_answers((r["player_id"], r["name"], f"{r['starts']} start{'s' if r['starts'] != 1 else ''}") for r in rows)
            for r in rows:
                prior[r["player_id"]] = round(r["starts"] / 2 + prior[r["player_id"]] * 0.1, 2)
            fact = f"The {season} {t['name']} went {t['record']} using {len(rows)} starting quarterbacks; {rows[0]['name']} started {rows[0]['starts']}."
            return self.name_one("deep", season, f"Name a QB who started a game for the {season} {t['name']}.", "player", valid, prior, fact)
        return None

    def _deep_play(self, rng, season):
        makers = {
            "season": (lambda: self.deep_whose_season(rng, season), 20),
            "leader": (lambda: self.deep_leader(rng, season), 15),
            "team_qbs": (lambda: self.deep_team_qbs(rng, season), 15),
            "career": (lambda: self.deep_whose_career(rng), 30),
            "feat": (lambda: self.deep_era_feat(rng), 20),
        }
        names = list(makers)
        first = rng.choices(names, weights=[w for _, w in makers.values()], k=1)[0]
        for n in [first] + [x for x in names if x != first]:
            r = makers[n][0]()
            if r:
                return r
        return None


    # ---- Broad questions (the simplified drive) ----------------------------------------
    def broad_span_feat(self, rng):
        """'Name a running back who ran for 1,500+ yards in a season since 1999 / in the 2010s.'"""
        for _ in range(60):
            pos, stat, label, ts = rng.choice(SPAN_FEATS)
            t = rng.choice(ts)
            lo, hi, when = rng.choice(TEAM_ERAS)
            hits = self._cached(("span", stat, pos, t, lo, hi), lambda: sorted(
                (p for p in self.d.players if p["position"] in pos and p[stat] >= t and lo <= p["season"] <= hi), key=lambda p: -p[stat]))
            if not 15 <= len({p["player_id"] for p in hits}) <= 150:
                continue
            if not self.fresh_topic(("bsf", stat, "".join(pos), t, lo, hi), ("tsf", stat, "".join(pos))):
                continue
            unit = UNIT.get(stat, "TD")
            valid, prior = self.player_answers((p["player_id"], p["name"], f"{fmt(p[stat])} {unit} in {p['season']}") for p in hits)
            top = hits[0]
            fact = f"The biggest: {top['name']} with {fmt(top[stat])} in {top['season']}."
            return self.name_one("play", era_chip(lo, hi),
                                 f"Name a {who_word(pos)} who {label.format(t=fmt(t))} {when}.", "player", valid, prior, fact)
        return None

    def broad_both_teams(self, rng):
        """'Name a player who played for both the Jets and the Patriots.'"""
        def build():
            out = {}
            for p in self.d.players:
                if p["games"] >= 4:
                    out.setdefault(p["player_id"], {}).setdefault(p["franchise"], []).append(p)
            return out
        teams_of = self._cached(("teams_of",), build)
        for _ in range(60):
            a, b = rng.sample(self.d.franchises, 2)
            hits = [(pid, t) for pid, t in teams_of.items() if a["franchise"] in t and b["franchise"] in t]
            if not 12 <= len(hits) <= 90:
                continue
            if not self.fresh(("bbt", *sorted((a["franchise"], b["franchise"]))), NAME_REUSE_DAYS):
                continue
            items = []
            for pid, t in hits:
                pa, pb = t[a["franchise"]], t[b["franchise"]]
                name = pa[0]["name"]
                span = lambda rows: f"{min(r['season'] for r in rows)}" + ("" if len({r['season'] for r in rows}) == 1 else f"–{max(r['season'] for r in rows)}")
                items.append((pid, name, f"{pa[0]['position']} · {a['name'].split()[-1]} {span(pa)}, {b['name'].split()[-1]} {span(pb)}"))
            valid, prior = self.player_answers(items)
            fact = f"{len(hits)} QBs, running backs, receivers and tight ends have played for both since 1999."
            return self.name_one("play", "Since 1999", f"Name a player who played for both the {a['name']} and the {b['name']}.",
                                 "player", valid, prior, fact, hint=f"QB, RB, WR or TE since 1999. There are {len(hits)} right answers.")
        return None

    def broad_franchise_leaders(self, rng):
        """'Name a player who led the Bears in rushing in a season since 1999.'"""
        for _ in range(60):
            f = rng.choice(self.d.franchises)
            stat, word, pos = rng.choice([("rushing_yards", "rushing", ("RB", "QB", "WR")), ("receiving_yards", "receiving", ("WR", "TE", "RB")),
                                          ("passing_yards", "passing", ("QB",))])
            lo, hi, when = rng.choice([(1999, 2025, "since 1999"), (2005, 2025, "since 2005"), (2010, 2025, "since 2010")])
            def build():
                out = {}
                for season in (s for s in self.d.seasons if lo <= s <= hi):
                    rows = [p for p in self.d.players_by_season[season] if p["franchise"] == f["franchise"] and p["position"] in pos]
                    if rows:
                        top = max(rows, key=lambda p: p[stat])
                        out.setdefault(top["player_id"], []).append(top)
                return out
            leaders = self._cached(("leaders", f["franchise"], stat, lo), build)
            if not 8 <= len(leaders) <= 40 or not self.fresh_topic(("bfl", f["franchise"], stat, lo), ("tl", f["franchise"], stat)):
                continue
            items = [(pid, rows[0]["name"], f"{len(rows)} season{'s' if len(rows) > 1 else ''} ({', '.join(str(r['season']) for r in rows[:4])}{'…' if len(rows) > 4 else ''})")
                     for pid, rows in sorted(leaders.items(), key=lambda kv: -len(kv[1]))]
            valid, prior = self.player_answers(items)
            for pid, rows in leaders.items():
                prior[pid] = round(prior[pid] * 0.5 + len(rows), 2)
            most = max(leaders.values(), key=len)
            fact = f"{most[0]['name']} led the {f['name']} in {word} yards {len(most)} times."
            return self.name_one("play", era_chip(lo, hi), f"Name a player who led the {f['name']} in {word} yards in a season {when}.",
                                 "player", valid, prior, fact)
        return None

    def _cached(self, key, build):
        cache = self.__dict__.setdefault("_cache", {})
        if key not in cache:
            cache[key] = build()
        return cache[key]

    FRANCHISE_SEASON = [
        (("QB",), "passing_tds", [15, 20], "threw {t}+ touchdown passes"),
        (("QB",), "passing_yards", [3000, 3500], "threw for {t}+ yards"),
        (("RB",), "rushing_yards", [700, 900], "ran for {t}+ yards"),
        (("RB",), "receptions", [35, 45], "caught {t}+ passes"),
        (("WR",), "receiving_yards", [700, 900], "had {t}+ receiving yards"),
        (("WR",), "receptions", [50, 65], "caught {t}+ passes"),
        (("TE",), "receptions", [35, 50], "caught {t}+ passes"),
        (("TE",), "receiving_yards", [400, 600], "had {t}+ receiving yards"),
        (("WR", "TE", "RB"), "receiving_tds", [6, 8], "caught {t}+ touchdown passes"),
        (("RB", "QB"), "rushing_tds", [6, 8], "ran for {t}+ touchdowns"),
    ]

    def broad_franchise_stat(self, rng):
        """'Name a receiver who had 800+ receiving yards in a season for the Bears since 1999.'"""
        for _ in range(60):
            f = rng.choice(self.d.franchises)
            pos, stat, ts, label = rng.choice(self.FRANCHISE_SEASON)
            t = rng.choice(ts)
            lo, hi, when = rng.choice(TEAM_ERAS)
            hits = self._cached(("fs", f["franchise"], stat, pos, t, lo, hi), lambda: sorted(
                (p for p in self.d.players if p["franchise"] == f["franchise"] and p["position"] in pos and p[stat] >= t and lo <= p["season"] <= hi),
                key=lambda p: -p[stat]))
            if not 8 <= len({p["player_id"] for p in hits}) <= 80:
                continue
            if not self.fresh_topic(("bfs", f["franchise"], stat, "".join(pos), t, lo, hi), ("ts", f["franchise"], stat)):
                continue
            unit = UNIT.get(stat, "TD")
            valid, prior = self.player_answers((p["player_id"], p["name"], f"{fmt(p[stat])} {unit} in {p['season']}") for p in hits)
            who = {("QB",): "QB", ("RB",): "running back", ("WR",): "receiver", ("TE",): "tight end"}.get(pos, "player")
            top = hits[0]
            fact = f"The best of these: {top['name']} with {fmt(top[stat])} in {top['season']}."
            return self.name_one("play", era_chip(lo, hi), f"Name a {who} who {label.format(t=fmt(t))} in a season for the {f['name']} {when}.",
                                 "player", valid, prior, fact)
        return None

    # ---- Division questions: four teams' worth of answers ---------------------------------
    DIVISION_SEASON = [
        (("QB",), "passing_yards", [3500, 4000], "threw for {t}+ yards"),
        (("QB",), "passing_tds", [25, 30], "threw {t}+ touchdown passes"),
        (("RB",), "rushing_yards", [1000, 1200], "ran for {t}+ yards"),
        (("RB",), "rushing_tds", [10, 12], "ran for {t}+ touchdowns"),
        (("WR", "TE"), "receiving_yards", [1000, 1200], "had {t}+ receiving yards"),
        (("WR", "TE"), "receptions", [80, 90], "caught {t}+ passes"),
        (("WR", "TE"), "receiving_tds", [8, 10], "caught {t}+ touchdown passes"),
        (("TE",), "receptions", [60, 70], "caught {t}+ passes"),
    ]

    def division_of(self):
        """Each franchise's current division."""
        return self._cached(("divisions",), lambda: {r["franchise"]: r["division"] for r in self.d.by_season[self.d.last] if r.get("division")})

    def broad_division(self, rng):
        """'Name a receiver who had 1,000+ receiving yards in a season for an AFC North team since 2010.'"""
        div_of = self.division_of()
        divisions = sorted(set(div_of.values()))
        for _ in range(60):
            div = rng.choice(divisions)
            members = {f for f, d in div_of.items() if d == div}
            lo, hi, when = rng.choice(TEAM_ERAS)
            article = "an" if div[0] in "AEIOU" else "a"
            if rng.random() < 0.25:
                rows = [r for r in self.d.qb_starts if r["franchise"] in members and lo <= r["season"] <= hi]
                by = {}
                for r in rows:
                    b = by.setdefault(r["player_id"], {"name": r["name"], "starts": 0, "teams": set()})
                    b["starts"] += r["starts"]
                    b["teams"].add(self.d.franchise_by_code[r["franchise"]]["name"].split()[-1])
                if not 12 <= len(by) <= 90 or not self.fresh_topic(("dvq", div, lo, hi), ("tdq", div)):
                    continue
                items = [(pid, b["name"], f"{b['starts']} starts ({', '.join(sorted(b['teams']))})") for pid, b in sorted(by.items(), key=lambda kv: -kv[1]["starts"])]
                valid, prior = self.player_answers(items)
                for pid, b in by.items():
                    prior[pid] = round(prior[pid] * 0.3 + b["starts"] / 4, 2)
                top = max(by.values(), key=lambda b: b["starts"])
                fact = f"{len(by)} quarterbacks started for {div} teams {when}. {top['name']} started the most ({top['starts']})."
                return self.name_one("play", era_chip(lo, hi), f"Name a QB who started a game for {article} {div} team {when}.", "player", valid, prior, fact)
            pos, stat, ts, label = rng.choice(self.DIVISION_SEASON)
            t = rng.choice(ts)
            hits = self._cached(("dv", div, stat, pos, t, lo, hi), lambda: sorted(
                (p for p in self.d.players if p["franchise"] in members and p["position"] in pos and p[stat] >= t and lo <= p["season"] <= hi),
                key=lambda p: -p[stat]))
            if not 8 <= len({p["player_id"] for p in hits}) <= 90:
                continue
            if not self.fresh_topic(("dvs", div, stat, "".join(pos), t, lo, hi), ("tdv", div, stat)):
                continue
            unit = UNIT.get(stat, "TD")
            valid, prior = self.player_answers((p["player_id"], p["name"], f"{fmt(p[stat])} {unit}, {p['team_name'].split()[-1]} {p['season']}") for p in hits)
            top = hits[0]
            fact = f"The best: {top['name']} with {fmt(top[stat])} for the {top['team_name']} in {top['season']}."
            return self.name_one("play", era_chip(lo, hi), f"Name a {who_word(pos)} who {label.format(t=fmt(t))} in a season for {article} {div} team {when}.",
                                 "player", valid, prior, fact)
        return None

    # ---- Team answers: "Name a franchise that ..." ----------------------------------------
    TEAM_SEASON = [
        ("won {t}+ games in a season", lambda r, t: r["wins"] >= t, [12, 13, 14]),
        ("won {t} or fewer games in a season", lambda r, t: r["wins"] <= t, [3, 4]),
        ("won a playoff game", lambda r, t: r["playoff_wins"] > 0, [0]),
        ("won its division", lambda r, t: r["division_rank"] == 1, [0]),
        ("led the NFL in points scored in a season", lambda r, t: r["pf_rank"] == 1, [0]),
        ("allowed the fewest points in the NFL in a season", lambda r, t: r["pa_rank"] == 1, [0]),
        ("lost {t}+ games in a row in a season", lambda r, t: r["longest_loss_streak"] >= t, [8, 10]),
        ("won {t}+ games in a row in a season", lambda r, t: r["longest_win_streak"] >= t, [9, 10]),
        ("reached the Super Bowl", lambda r, t: r["won_super_bowl"] or r["lost_super_bowl"], [0]),
    ]

    def broad_team_seasons(self, rng):
        for _ in range(40):
            label, test, ts = rng.choice(self.TEAM_SEASON)
            t = rng.choice(ts)
            lo, hi, when = rng.choice(TEAM_ERAS)
            rows = [r for r in self.d.rows if lo <= r["season"] <= hi and test(r, t)]
            by = {}
            for r in rows:
                by.setdefault(r["franchise"], []).append(r["season"])
            if not 8 <= len(by) <= 22:
                continue
            if not self.fresh_topic(("tsn", label, t, lo, hi), ("tts", label)):
                continue
            valid = {f: {"name": self.d.franchise_by_code[f]["name"],
                         "note": f"{len(ss)} time{'s' if len(ss) > 1 else ''} ({', '.join(map(str, sorted(ss)[:5]))}{'…' if len(ss) > 5 else ''})"}
                     for f, ss in by.items()}
            prior = {f: round(len(ss) * 2 + self.franchise_weight(f) / 4, 2) for f, ss in by.items()}
            most = max(by, key=lambda f: len(by[f]))
            text = label.format(t=t)
            fact = f"{len(by)} franchises did it {when}; the {self.d.franchise_by_code[most]['name']} did it most ({len(by[most])})."
            return self.name_one("play", era_chip(lo, hi), f"Name a franchise that {text} {when}.", "team", valid, prior, fact)
        return None

    def broad_play(self, rng):
        makers = [
            (lambda: self.broad_span_feat(rng), 3),
            (lambda: self.broad_franchise_stat(rng), 4),
            (lambda: self.pass_franchise_qbs(rng), 3),
            (lambda: self.broad_division(rng), 4),
            (lambda: self.broad_team_seasons(rng), 2),
            (lambda: self.broad_both_teams(rng), 1),
            (lambda: self.pass_franchise_1000(rng), 2),
            (lambda: self.broad_franchise_leaders(rng), 2),
            (lambda: self.pass_career_list(rng), 2),
            (lambda: self.pass_franchise_list(rng), 1),
        ]
        counts = self.__dict__.setdefault("kinds_today", {})
        if getattr(self, "_kinds_date", None) != self.date:
            counts.clear()
            self._kinds_date = self.date
        order = rng.choices(range(len(makers)), weights=[w for _, w in makers], k=len(makers) * 2)
        for cap in (MAX_PER_KIND, 99):  # mix it up; only repeat a kind more if nothing else is left
            for i in order + list(range(len(makers))):
                if counts.get(i, 0) >= cap:
                    continue
                r = makers[i][0]()
                if r:
                    counts[i] = counts.get(i, 0) + 1
                    return r
        return None

    # ---- names index for autocomplete ------------------------------------------------------
    def names_index(self):
        players = {}
        for c in self.d.careers:
            players[c["player_id"]] = [c["player_id"], c["name"], c["position"], c["start"], c["end"]]
        for r in self.d.qb_starts:
            if r["player_id"] not in players:
                players[r["player_id"]] = [r["player_id"], r["name"], "QB", r["season"], r["season"]]
            else:
                p = players[r["player_id"]]
                p[3], p[4] = min(p[3], r["season"]), max(p[4], r["season"])
        teams = [[f["franchise"], f["name"], sorted(f["old_names"]), f["color"], f["color2"]] for f in self.d.franchises]
        return {"players": sorted(players.values(), key=lambda p: p[1]), "teams": sorted(teams, key=lambda t: t[1])}
