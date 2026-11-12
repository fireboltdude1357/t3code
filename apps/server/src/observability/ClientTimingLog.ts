import type { AuthSessionId, ClientTimingReport } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeAsyncRotatingFileSink } from "@t3tools/shared/logging";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeOS from "node:os";

import packageJson from "../../package.json" with { type: "json" };

import * as ServerConfig from "../config.ts";

const MAX_BYTES = 1_000_000;
const MAX_FILES = 5;

export class ClientTimingLog extends Context.Service<
  ClientTimingLog,
  {
    readonly append: (input: {
      readonly sessionId: AuthSessionId;
      readonly report: ClientTimingReport;
    }) => Effect.Effect<void>;
  }
>()("t3/observability/ClientTimingLog") {}

/** One NDJSON line per record, so a client's timings can be read beside the server's logs. */
export const make = Effect.fn("ClientTimingLog.make")(function* (filePath: string) {
  // Windows has no load average; os.loadavg() reports zeros there.
  const hasLoadAverage = !(yield* HostProcess.isWindows);
  const sink = yield* makeAsyncRotatingFileSink({
    filePath,
    maxBytes: MAX_BYTES,
    maxFiles: MAX_FILES,
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Client timings will not be saved.", { error }).pipe(Effect.as(undefined)),
    ),
  );
  return ClientTimingLog.of({
    append: Effect.fn("ClientTimingLog.append")(function* ({ sessionId, report }) {
      if (sink === undefined || report.records.length === 0) return;
      const receivedAt = DateTime.formatIso(yield* DateTime.now);
      const [load1m = 0] = NodeOS.loadavg();
      const server = {
        version: packageJson.version,
        ...(hasLoadAverage ? { load1m: Math.round(load1m * 100) / 100 } : {}),
      };
      const lines = report.records
        .map(
          (record) =>
            `${JSON.stringify({ receivedAt, sessionId, server, app: report.app, ...record })}\n`,
        )
        .join("");
      yield* sink
        .write(lines)
        .pipe(
          Effect.catch((error) => Effect.logWarning("Could not save client timings.", { error })),
        );
    }),
  });
});

export const layer = Layer.effect(
  ClientTimingLog,
  Effect.gen(function* () {
    const { clientTimingsPath } = yield* ServerConfig.ServerConfig;
    return yield* make(clientTimingsPath);
  }),
);
