# Fourth & Daily

A daily football trivia game played as one drive. **You're down 21–17 with the ball on your own 25.** Every play is one question you answer by typing a name:

- *"Name a QB who started a game for the Cleveland Browns since 1999"* (42 right answers)
- *"Name a player who played for both the Jets and the Patriots"*
- *"Name a running back who ran for 1,500+ yards in a season in the 2010s"*

A right answer is a pass, and how far it goes depends on how deep a cut it is:

| Tier | Which right answers | Yards |
|---|---|---|
| 🟨 **Check Down** | the most obvious ~40% | 7 (two make a first down) |
| 🟩 **Seam Route** | the middle ~35% | 20 |
| 💣 **Bomb** | the deepest ~25%, or a question's only answer | 40 |

How obvious an answer is comes from our own stats, not from other players, so it works from day one and everyone gets the same yards for the same answer. Each right answer carries an "obviousness" weight (career production since 1999, how many times the player fits the question, starts, seasons leading the team, team success). Answers to each question are ranked by it and split into the three tiers. Each question shows its split ("3 bombs · 3 seams · 4 check-downs"). A wrong answer, or running out the 30-second timer, is an incomplete pass. You have **4 downs to gain 10 yards**, and reaching the end zone wins it (touchdown plus automatic extra point = 7). After each play you see every right answer, grouped by tier.

Questions are always broad, covering a franchise or a span like "since 1999" or "in the 2010s", never a single season. Each has at least 6 right answers (usually 10+). Results rank by **points, then yards, then fewer plays**.

Players also get a pixel-art broadcast field that animates every play, a shareable drive chart (💣🟩🟨⬜🏈) with a link preview, streaks and stats, "how everyone else did", a calendar of past drives, optional accounts with daily and all-time leaderboards, friends leagues, and an installable home-screen app.

## How it works

```
scripts/build_db.py         downloads nflverse data -> data/nfl.sqlite
scripts/generate_puzzles.py data/nfl.sqlite + data/facts.json -> puzzles/YYYY-MM-DD.json (16 broad name-one questions a day) and site/names.json (autocomplete)
scripts/playbook.py         the open-ended "name one" question types
puzzles/                    full puzzles with answers (private; never served directly)
api/                        Vercel serverless functions
lib/                        shared server code (grading, accounts, leaderboards)
site/                       static website (index.html, style.css, app.js)
site/drive.js               the rules of a drive (yards from how deep a cut the answer is, downs, scoring), shared by browser and server
lib/plays.js                grading a play: right or wrong, and how deep a cut the answer is
site/fieldview.js           the animated broadcast field
site/pixel.js               pixel-art stadium renderer (shared by the site background and share images)
```

- **Answers stay on the server.** `/api/answer` grades a guess and only then returns the answer and fact. Puzzles for future dates can't be loaded.
- **Signed-in drives run on the server** (`/api/drive`): the server hands out one play at a time, times each answer itself, applies the rules in `site/drive.js` and saves the drive. That's what makes leaderboard results trustworthy. Reloading mid-play doesn't stop the play clock, and a play left hanging past it becomes delay of game.
- **Anonymous drives run in the browser** with the same rules, saved in localStorage. When one finishes, the browser sends the play log to `/api/stats`, where the server replays it, re-grades every guess and adds it to "how everyone did". These never reach leaderboards.
- **Accounts** are a username and password (scrypt-hashed, httpOnly session cookie, lockout after 10 bad passwords).
- **Leaderboards** count only drives finished on the day by signed-in players. Archive drives count toward stats, but not toward streaks or leaderboards.
- **Friends leagues:** any signed-in player can create a league, which gets a 6-character invite code and a link like `/?join=ABC234`. Opening the link signs the player in if needed and then joins. Each league has its own daily and all-time board. When the owner leaves, the longest-standing member takes over, and empty leagues are deleted.
- **How everyone did:** every answered question adds to per-question totals, so players see "38% got this right" after each play, and every finished drive adds to that day's results ("Better than 71% of 1,204 drives today · 34% scored a TD"). These counts aren't tamper-proof, which is fine for a fun stat; leaderboards only use server-run drives.
- Without a database the game still works: anonymous play, with stats saved in the browser. Accounts, leagues and crowd stats are hidden or show as "not set up yet".
- **Installable:** `site/manifest.webmanifest` and pixel icons (`node scripts/make-icons.mjs`) let players add the game to their home screen. The results and profile screens offer an install button where the browser supports one, and instructions on iPhone.
- **Analytics:** the site loads Vercel Web Analytics (page views only, no cookies) on the real domain. It does nothing until Analytics is turned on in the Vercel project.

### Look and sharing

- The background is a pixel-art stadium drawn on a canvas by `site/stadium.js`: a field down the middle with crowds on both sides, and a crowd wave every 15 seconds (skipped with reduced motion). Dark mode turns it into a night game.
- **Share previews:** the Share button links to `/s/<puzzle>-<points>-<yards>-<secondsLeft>-<plays>` (for example `/s/17-7-75-48-ggbmtp`). That page carries Open Graph tags whose image comes from `/api/og`, a 1200×630 pixel-art scoreboard showing the result and drive chart, so iMessage, Discord, X and others show it. Visitors are sent straight on to the game.
- `site/og.png` is the generic preview for the home page. Regenerate it with `node scripts/make-og.mjs` after changing the art. On Vercel, `scripts/build-meta.mjs` turns its URL into an absolute one, since some apps ignore relative preview URLs.

### Database (`data/nfl.sqlite`)

This is the trivia data used to generate puzzles (separate from the Postgres database that holds accounts).

- `games`: every game since 1999 (regular season and playoffs), with scores.
- `team_seasons`: one row per team per completed season, with record, points for/against, league ranks, division rank, playoff result, head coach, main starting QB, record in one-score games, division record, home/away record, biggest win, worst loss, start record and streaks.
- `player_seasons`: regular-season stats for QBs, RBs, WRs and TEs, with league ranks.
- `qb_starts`: every quarterback who started a game, by team and season (for "name a QB who started for…").
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

A question can come back after a year (`REUSE_DAYS`), never sooner, and no answer repeats among the all-time questions within one drive. To redo days nobody has played yet, use `--from YYYY-MM-DD`.

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

- Puzzles are generated in advance. Once a season's star players have all been used, a player can reappear in "Who am I?" or a team as the odd one out, but never with the same answer choices. A question type that runs dry for a season falls back to another type.
- Days played in the original 5-round format still count toward "played" in stats.
- Anonymous players are graded statelessly, so someone could probe the API for answers. That's why only signed-in, same-day games reach leaderboards.
- Data comes from [nflverse](https://github.com/nflverse) (CC-BY 4.0).
