import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { relayDatabaseMode } from "./dbConfig.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

export const PlanetscaleDatabase = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const schema = yield* Drizzle.Schema("RelaySchema", {
    schema: "./src/persistence/schema.ts",
    out: "./migrations/postgres",
    dialect: "postgres",
  });

  const mode = relayDatabaseMode(stage);
  // PlanetScale Postgres replaces the database when replicas change; size resizes in place.
  const clusterSize = yield* Config.NonEmptyString("RELAY_DB_CLUSTER_SIZE").pipe(
    Config.withDefault("PS_80"),
  );
  const replicas = yield* Config.Int("RELAY_DB_REPLICAS").pipe(Config.withDefault(2));
  const database =
    mode === "shared-database"
      ? yield* Planetscale.PostgresDatabase("RelayPostgresDatabase", {
          name: "t3coderelay",
          region: { slug: "us-west" },
          clusterSize,
          migrations: { dir: schema.out, table: "relay_migrations" },
          replicas,
        }).pipe(RemovalPolicy.retain())
      : yield* Planetscale.PostgresDatabase.ref("RelayPostgresDatabase", {
          stage: "prod",
        });
  const branch =
    mode === "stage-branch"
      ? yield* Planetscale.PostgresBranch("RelayPostgresBranch", {
          database,
          migrations: { dir: schema.out, table: "relay_migrations" },
        })
      : undefined;

  const runtimeRole = yield* Planetscale.PostgresRole("RelayPostgresRuntimeRole", {
    database,
    ...(branch ? { branch } : {}),
    inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
  });

  return { branch, database, runtimeRole };
});

export const RelayHyperdrive = Effect.gen(function* () {
  const { runtimeRole } = yield* PlanetscaleDatabase;
  // Cloudflare's free Workers plan only accepts 5 to 20.
  const originConnectionLimit = yield* Config.Int("RELAY_HYPERDRIVE_CONNECTION_LIMIT").pipe(
    Config.withDefault(40),
  );
  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    origin: runtimeRole.origin,
    caching: {
      disabled: true,
    },
    originConnectionLimit,
  });
});
