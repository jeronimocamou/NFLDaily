# Fourth & Daily

A daily football trivia game. Every day has 5 rounds, each from a different season (1999–2025):

| Round | Type | Scoring |
|---|---|---|
| 1 | **Head to head**: which team had the better record, or which player had more yards/TDs/catches (always close) | 100 or 0 |
| 2 | **Odd one out**: which team missed (or made) the playoffs | 100 or 0 |
| 3 | **Guess the number**: a team's wins or points, or a player's yards, TDs or catches | partial credit for close guesses |
| 4 | **Rank four**: order a division, 4 teams or 4 players | 25 per correct spot |
| 5 | **Who am I?**: name the player from a stat line. A miss reveals his team for one more try | 100, then 50 |

Max score is 500. Players get a shareable emoji grid (🟩🟨🟧🟥) with a pixel-art link preview, streaks, stats, "how everyone else did" after every round, a calendar of past puzzles, optional accounts with daily and all-time leaderboards, private friends leagues, and an installable home-screen app.

## How it works

```
scripts/build_db.py         downloads nflverse data -> data/nfl.sqlite
scripts/generate_puzzles.py data/nfl.sqlite + data/facts.json -> puzzles/YYYY-MM-DD.json
puzzles/                    full puzzles with answers (private; never served directly)
api/                        Vercel serverless functions
lib/                        shared server code (grading, accounts, leaderboards)
site/                       static website (index.html, style.css, app.js)
site/pixel.js               pixel-art stadium renderer (shared by the site background and share images)
```

- **Answers stay on the server.** `/api/puzzle` sends each round without its answer, and `/api/answer` grades a guess and only then returns the answer and fact. Puzzles for future dates can't be loaded.
- **Accounts** are a username and password (scrypt-hashed, httpOnly session cookie, lockout after 10 bad passwords). Signed-in players' answers are saved on the server and locked once given, so leaderboard scores are honest. Games played before signing in are imported when you sign up, but only for stats.
- **Leaderboards** count only games finished on the day by signed-in players. Archive games count toward "played" and average, but not toward streaks or leaderboards.
- **Friends leagues:** any signed-in player can create a league, which gets a 6-character invite code and a link like `/?join=ABC234`. Opening the link signs the player in if needed and then joins. Each league has its own daily and all-time board. When the owner leaves, the longest-standing member takes over, and empty leagues are deleted.
- **How everyone did:** every finished round, signed in or not, adds to per-round totals, so players see "38% got this right" after each answer and "You beat 71% of 1,204 players" at the end. Anonymous players send their other guesses with their final answer so the server can grade the whole game itself. These counts aren't tamper-proof, which is fine for a fun stat; leaderboards still use only signed-in games.
- Without a database the game still works: anonymous play, with stats saved in the browser. Accounts, leagues and crowd stats are hidden or show as "not set up yet".
- **Installable:** `site/manifest.webmanifest` and pixel icons (`node scripts/make-icons.mjs`) let players add the game to their home screen. The results and profile screens offer an install button where the browser supports one, and instructions on iPhone.
- **Analytics:** the site loads Vercel Web Analytics (page views only, no cookies) on the real domain. It does nothing until Analytics is turned on in the Vercel project.

### Look and sharing

- The background is a pixel-art stadium drawn on a canvas by `site/stadium.js`: a field down the middle with crowds on both sides, and a crowd wave every 15 seconds (skipped with reduced motion). Dark mode turns it into a night game.
- **Share previews:** the Share button links to `/s/<puzzle>-<score>-<grid>` (for example `/s/16-410-ggmlb`). That page carries Open Graph tags whose image comes from `/api/og`, a 1200×630 pixel-art scoreboard with that score and colored squares, so iMessage, Discord, X and others show the result. Visitors are sent straight on to the game.
- `site/og.png` is the generic preview for the home page. Regenerate it with `node scripts/make-og.mjs` after changing the art. On Vercel, `scripts/build-meta.mjs` turns its URL into an absolute one, since some apps ignore relative preview URLs.

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

To see visitor numbers, open the Vercel project's **Analytics** tab and click **Enable**.

## Commands

Rebuild the trivia data (add `--refresh` to re-download):

```bash
python3 scripts/build_db.py
```

Add puzzles. This keeps every existing day as it is and appends new days through a year from today (or `--through YYYY-MM-DD`). `puzzles/state.json` remembers every question already used, so nothing repeats:

```bash
python3 scripts/generate_puzzles.py
```

A GitHub Action (`.github/workflows/puzzles.yml`) does this on the 1st of every month. It refreshes the trivia data (so new seasons show up after each Super Bowl), adds puzzles, runs the tests and commits to `main`, which redeploys the site. You can also run it from the repo's **Actions** tab. `--rebuild` regenerates every day from launch (puzzle #1 = 2026-11-01) and changes past puzzles, so avoid it once players have played.

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

- Puzzles are generated in advance. Once all of a season's star players have been used, a player can reappear in "Who am I?" or a team as the odd one out, but never with the same answer choices.
- Anonymous players are graded statelessly, so someone could probe the API for answers. That's why only signed-in, same-day games reach leaderboards.
- Data comes from [nflverse](https://github.com/nflverse) (CC-BY 4.0).
