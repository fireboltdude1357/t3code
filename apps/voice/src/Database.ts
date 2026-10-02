import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration001 from "./migrations/001_VoiceOrchestrator.ts";
import Migration002 from "./migrations/002_VoiceNoticeRequests.ts";

/**
 * The sidecar's own SQLite file. It never opens the T3 server's database, so
 * upstream migration numbers can't collide with these.
 */
const migrations = [
  [1, "VoiceOrchestrator", Migration001],
  [2, "VoiceNoticeRequests", Migration002],
] as const;

/** Runs pending migrations up to `through` (all by default). Returns those that ran. */
export const migrate = (through?: number) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        migrations
          .filter(([id]) => through === undefined || id <= through)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* migrate();
  }),
);

export const layer = (dbPath: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
      return Layer.provideMerge(setup, NodeSqliteClient.layer({ filename: dbPath }));
    }),
  );

export const layerMemory = Layer.provideMerge(
  setup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);
