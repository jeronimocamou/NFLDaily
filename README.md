# NFL Daily

A daily NFL trivia game. Every day has 5 rounds, each from a different season (1999–2025):

| Round | Type | Scoring |
|---|---|---|
| 1 | **Head to head**: which team had the better record, or which player had more yards/TDs/catches (always close) | 100 or 0 |
| 2 | **Odd one out**: which team missed (or made) the playoffs | 100 or 0 |
| 3 | **Guess the number**: a team's wins or points, or a player's yards, TDs or catches | partial credit for close guesses |
| 4 | **Rank four**: order a division, 4 teams or 4 players | 25 per correct spot |
| 5 | **Who am I?**: name the player from a stat line. A miss reveals his team for one more try | 100, then 50 |

Max score is 500. Players get a shareable emoji grid (🟩🟨🟧🟥), streaks, stats, a calendar of past puzzles, and optional accounts with daily and all-time leaderboards.

## How it works

```
scripts/build_db.py         downloads nflverse data -> data/nfl.sqlite
scripts/generate_puzzles.py data/nfl.sqlite + data/facts.json -> puzzles/YYYY-MM-DD.json
puzzles/                    full puzzles with answers (private; never served directly)
api/                        Vercel serverless functions
lib/                        shared server code (grading, accounts, leaderboards)
site/                       static website (index.html, style.css, app.js)
```

- **Answers stay on the server.** `/api/puzzle` sends each round without its answer, and `/api/answer` grades a guess and only then returns the answer and fact. Puzzles for future dates can't be loaded.
- **Accounts** are a username and password (scrypt-hashed, httpOnly session cookie, lockout after 10 bad passwords). Signed-in players' answers are saved on the server and locked once given, so leaderboard scores are honest. Games played before signing in are imported when you sign up, but only for stats.
- **Leaderboards** count only games finished on the day by signed-in players. Archive games count toward "played" and average, but not toward streaks or leaderboards.
- Without a database the game still works: anonymous play, with stats saved in the browser. Accounts and leaderboards show as "not set up yet".

### Database (`data/nfl.sqlite`)

This is the trivia data used to generate puzzles (separate from the Postgres database that holds accounts).

- `games`: every game since 1999 (regular season and playoffs), with scores.
- `team_seasons`: one row per team per completed season, with record, points for/against, league ranks, division rank, playoff result, head coach, main starting QB, record in one-score games, division record, home/away record, biggest win, worst loss, start record and streaks.
- `player_seasons`: regular-season stats for QBs, RBs, WRs and TEs, with league ranks.
- `franchises`: the current 32 franchises, with colors.

`data/facts.json` holds hand-written facts for about 60 famous team-seasons (the 2007 Patriots, 2008 Lions, 28-3, …), each checked against the game data. Other facts are generated from the data above.

## Setting up accounts and leaderboards on Vercel (one time)

1. In your Vercel project, open **Storage** and click **Create Database**. Pick **Neon** (Postgres) and accept the free plan.
2. Connect it to the `nfldaily` project for all environments. This adds a `DATABASE_URL` environment variable.
3. Redeploy: **Deployments → … → Redeploy**, or push any commit.

The tables are created automatically on the first request. Any Postgres works, too: set `DATABASE_URL` yourself.

## Commands

Rebuild the trivia data (add `--refresh` to re-download):

```bash
python3 scripts/build_db.py
```

Regenerate puzzles. The defaults are 380 days starting from launch (puzzle #1 = 2026-11-01). Regenerating changes past puzzles, so only do it to extend the range or before launch:

```bash
python3 scripts/generate_puzzles.py
```

Install dependencies:

```bash
npm install
```

Run grading and data tests:

```bash
npm test
```

Run locally. Without `DATABASE_URL`, accounts are disabled:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/nfldaily npm run dev
```

Then open http://localhost:3000. Add `?date=2026-11-05` to play a past day.

## Notes

- Puzzles are generated in advance and deterministically, and no question repeats within the generated range.
- Anonymous players are graded statelessly, so someone could probe the API for answers. That's why only signed-in, same-day games reach leaderboards.
- Data comes from [nflverse](https://github.com/nflverse) (CC-BY 4.0).
