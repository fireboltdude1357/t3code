import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The voice orchestrator's own memory. Plain tables, not domain events,
// because voice state is not thread history.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per orchestrator; `generation` only ever increases.
  yield* sql`
    CREATE TABLE IF NOT EXISTS voice_sessions (
      session_key TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS voice_agenda (
      item_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      thread_id TEXT,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT
    )
  `;
  // At most one open item per thread; also the upsert target for thread items.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_agenda_open_thread
    ON voice_agenda(thread_id)
    WHERE status = 'open' AND thread_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS voice_notice_ledger (
      notice_id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      thread_title TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_voice_notice_ledger_created
    ON voice_notice_ledger(created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS voice_transcript (
      entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
      generation INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      at TEXT NOT NULL
    )
  `;
});
