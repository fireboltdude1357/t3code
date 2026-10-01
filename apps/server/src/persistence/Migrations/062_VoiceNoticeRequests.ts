import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork databases may already have these columns from when this migration had
  // a lower id, so add only the missing ones.
  const columns = new Set(
    (yield* sql<{ readonly name: string }>`PRAGMA table_info(voice_notice_ledger)`).map(
      (column) => column.name,
    ),
  );
  if (!columns.has("request_id")) {
    yield* sql`ALTER TABLE voice_notice_ledger ADD COLUMN request_id TEXT`;
  }
  if (!columns.has("resolved_at")) {
    yield* sql`ALTER TABLE voice_notice_ledger ADD COLUMN resolved_at TEXT`;
  }

  // IDs can contain delimiters, so remove only the known thread prefix and kind suffix.
  yield* sql`
    UPDATE voice_notice_ledger
    SET request_id = substr(
      dedupe_key,
      length(thread_id || ':request:') + 1,
      length(dedupe_key) - length(thread_id || ':request:') - length(':' || kind)
    )
    WHERE kind IN ('input', 'approval')
      AND substr(dedupe_key, 1, length(thread_id || ':request:')) = thread_id || ':request:'
      AND substr(dedupe_key, -length(':' || kind)) = ':' || kind
      AND length(dedupe_key) > length(thread_id || ':request:') + length(':' || kind)
  `;
});
