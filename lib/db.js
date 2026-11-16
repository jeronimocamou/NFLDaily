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
