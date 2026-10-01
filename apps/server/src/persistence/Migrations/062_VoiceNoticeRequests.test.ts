import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("062_VoiceNoticeRequests", (it) => {
  it.effect("runs on a fork database that already has the request columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      // Fork builds applied this migration under an older id.
      yield* sql`ALTER TABLE voice_notice_ledger ADD COLUMN request_id TEXT`;
      yield* sql`ALTER TABLE voice_notice_ledger ADD COLUMN resolved_at TEXT`;

      yield* runMigrations({ toMigrationInclusive: 62 });

      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(voice_notice_ledger)`;
      const names = columns.map((column) => column.name);
      assert.equal(names.filter((name) => name === "request_id").length, 1);
      assert.equal(names.filter((name) => name === "resolved_at").length, 1);
    }),
  );
});
