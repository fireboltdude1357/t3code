/**
 * Creates or upgrades the sidecar database without starting the sidecar, so a
 * deploy can import older voice state before the first start:
 *   node apps/voice/src/migrate.ts ~/.t3-voice/voice.sqlite
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Database from "./Database.ts";

const dbPath = process.argv[2];
if (dbPath === undefined) throw new Error("usage: migrate.ts <voice.sqlite>");

// Building the layer runs every pending migration; closing the scope closes the file.
Layer.build(Database.layer(dbPath)).pipe(
  Effect.scoped,
  Effect.tap(() => Effect.logInfo("voice.db.migrated", { dbPath })),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
