import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// Single shared SQLite connection. File lives under ./data so it persists across restarts.
const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "app.db");

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  migrate(_db);
  return _db;
}

function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Idempotency store: a Drive file id is recorded here once fully processed.
    CREATE TABLE IF NOT EXISTS processed_files (
      file_id      TEXT PRIMARY KEY,
      file_name    TEXT,
      processed_at  TEXT NOT NULL
    );

    -- One row per pipeline run for a meeting (success or failure).
    CREATE TABLE IF NOT EXISTS runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id         TEXT NOT NULL,
      file_name       TEXT,
      status          TEXT NOT NULL,            -- 'running' | 'success' | 'failed'
      error           TEXT,
      transcript      TEXT,
      summary         TEXT,
      notion_url      TEXT,
      unmapped_speakers TEXT,                   -- JSON array of speaker labels not matched to a person
      transcribe_model  TEXT,
      postprocess_model TEXT,
      started_at      TEXT NOT NULL,
      finished_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS action_items (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    INTEGER NOT NULL,
      owner     TEXT,
      task      TEXT NOT NULL,
      due       TEXT,
      context   TEXT,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );

    -- One row per polling pass (cron tick or manual "Run now") for observability.
    CREATE TABLE IF NOT EXISTS polls (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at    TEXT NOT NULL,
      trigger   TEXT NOT NULL,            -- 'cron' | 'manual'
      found     INTEGER NOT NULL,         -- new files seen this pass
      succeeded INTEGER NOT NULL,
      failed    INTEGER NOT NULL,
      error     TEXT                      -- poll-level error (e.g. Drive listing failed)
    );

    CREATE INDEX IF NOT EXISTS idx_runs_file ON runs(file_id);
    CREATE INDEX IF NOT EXISTS idx_action_run ON action_items(run_id);
    CREATE INDEX IF NOT EXISTS idx_polls_ran ON polls(ran_at);
  `);

  // Additive migrations for columns introduced after the initial schema.
  ensureColumn(d, "runs", "raw_transcript", "TEXT");
  ensureColumn(d, "action_items", "evidence", "TEXT");
  ensureColumn(d, "runs", "meeting_time", "TEXT"); // ISO; ~ when the meeting happened
  ensureColumn(d, "runs", "attendees", "TEXT"); // JSON array of participant names
  ensureColumn(d, "runs", "meeting_key", "TEXT"); // dedup key derived from the recording name
  d.exec(`CREATE INDEX IF NOT EXISTS idx_runs_key ON runs(meeting_key);`);

  // Cost/usage tracking (added later). transcribe_model + postprocess_model already exist;
  // clean_model is the third stage's model. total_cost_usd + audio_seconds are flat for quick
  // display/sorting; cost_json holds the full per-stage breakdown (tokens + USD per stage).
  ensureColumn(d, "runs", "clean_model", "TEXT");
  ensureColumn(d, "runs", "audio_seconds", "REAL");
  ensureColumn(d, "runs", "total_cost_usd", "REAL");
  ensureColumn(d, "runs", "cost_json", "TEXT");
}

// Add a column if it does not already exist (SQLite has no ADD COLUMN IF NOT EXISTS).
function ensureColumn(
  d: Database.Database,
  table: string,
  col: string,
  decl: string
) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === col)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}
