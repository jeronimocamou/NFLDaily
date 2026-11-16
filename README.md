# NFL Daily

A daily NFL trivia game. Every day has 5 rounds, each from a different season (1999–2025):

| Round | Type | Scoring |
|---|---|---|
| 1 | **Better record**: which of two teams had the better record (always close) | 100 or 0 |
| 2 | **Odd one out**: which team missed (or made) the playoffs | 100 or 0 |
| 3 | **Guess the number**: a team's win total | 100 / 60 / 30 / 10 for exact / 1 / 2 / 3 off |
| 4 | **Rank four**: order a division (or 4 teams) by record or points | 25 per correct spot |
| 5 | **Guess the number**: a team's points scored | 100 within 10 pts, down to 0 at 110 off |

Max score is 500. Players get a shareable emoji grid (🟩🟨🟧🟥), plus streaks and stats saved in the browser.

## Layout

```
scripts/build_db.py         downloads nflverse data -> data/nfl.sqlite
scripts/generate_puzzles.py data/nfl.sqlite -> site/puzzles/YYYY-MM-DD.json
data/nfl.sqlite             the database (committed; rebuild any time)
site/                       static website (index.html, style.css, app.js, puzzles/)
```

### Database (`data/nfl.sqlite`)

- `games`: every played game since 1999 (regular season + playoffs) with scores.
- `team_seasons`: one row per team per completed season with record, points for/against, point diff, league ranks, division rank, playoff result, start record (first 8 games) and longest win/loss streaks. Names match the season ("San Diego Chargers", "Washington Football Team").
- `franchises`: the current 32 franchises with conference, division and colors. Relocated teams map to their current franchise (OAK→LV, SD→LAC, STL→LA).

Example:

```bash
sqlite3 data/nfl.sqlite "SELECT name, record, playoff_exit FROM team_seasons WHERE season = 2013 ORDER BY win_pct DESC LIMIT 5"
```

## Commands

Rebuild the database (add `--refresh` to re-download the source data):

```bash
python3 scripts/build_db.py
```

Generate puzzles. The defaults are 365 days starting from launch (puzzle #1 = 2026-11-16):

```bash
python3 scripts/generate_puzzles.py --days 365
```

Run the site locally:

```bash
python3 -m http.server 8000 --directory site
```

Then open http://localhost:8000. Add `?date=2026-12-25` to play any generated date.

## Deploying

### Vercel (recommended)

`vercel.json` serves `site/` as a static site with no build step. To set it up once:

1. Go to https://vercel.com/new and sign in with GitHub.
2. Import the `nfldaily` repository and click **Deploy**. Leave all settings at their defaults.

From then on, every push to `main` updates the live site, and every other branch gets its own preview URL.

### GitHub Pages

`.github/workflows/pages.yml` publishes `site/` to GitHub Pages on every push to `main`. To turn it on, open the repo's **Settings → Pages** and set **Source** to **GitHub Actions**.

## Notes

- Puzzles are generated in advance and deterministically, and no question repeats within a generated range.
- Answers are in the puzzle JSON files, so a determined player could peek. That's fine for now. Later we could serve each day's file only on that day, or hash the answers.
- Data comes from [nflverse](https://github.com/nflverse) (CC-BY 4.0).
