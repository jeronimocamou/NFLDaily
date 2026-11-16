// Postgres access. Works with Neon/Vercel Postgres (DATABASE_URL or
// POSTGRES_URL) or any Postgres. If neither is set, account features are
// disabled and the game still works for anonymous players.
import pg from "pg";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
let pool = null;
let ready = null;

export const dbEnabled = Boolean(url);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  round INT NOT NULL,
  guesses JSONB NOT NULL DEFAULT '[]',
  attempts INT NOT NULL DEFAULT 0,
  score INT NOT NULL DEFAULT 0,
  done BOOLEAN NOT NULL DEFAULT false,
  on_time BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date, round)
);
CREATE INDEX IF NOT EXISTS results_date ON results (date);
CREATE TABLE IF NOT EXISTS drives (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  state JSONB NOT NULL,
  points INT NOT NULL DEFAULT 0,
  yards INT NOT NULL DEFAULT 0,
  clock INT NOT NULL DEFAULT 0,
  rank BIGINT NOT NULL DEFAULT 0,
  done BOOLEAN NOT NULL DEFAULT false,
  on_time BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);
CREATE INDEX IF NOT EXISTS drives_date ON drives (date) WHERE done;
CREATE TABLE IF NOT EXISTS round_stats (
  date DATE NOT NULL,
  round INT NOT NULL,
  plays INT NOT NULL DEFAULT 0,
  perfect INT NOT NULL DEFAULT 0,
  total_score BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (date, round)
);
CREATE TABLE IF NOT EXISTS leagues (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  owner_id INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS league_members (
  league_id INT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, user_id)
);
CREATE INDEX IF NOT EXISTS league_members_user ON league_members (user_id);
CREATE TABLE IF NOT EXISTS day_scores (
  date DATE NOT NULL,
  score INT NOT NULL,
  players INT NOT NULL DEFAULT 0,
  PRIMARY KEY (date, score)
);
`;

export async function db() {
  if (!url) return null;
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    // DATE columns come back as 'YYYY-MM-DD' strings, not JS Dates.
    pg.types.setTypeParser(1082, (v) => v);
  }
  if (!ready) {
    ready = pool.query(SCHEMA).catch((e) => {
      ready = null;
      throw e;
    });
  }
  await ready;
  return pool;
}
