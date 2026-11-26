import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import * as ClientTimingLog from "./ClientTimingLog.ts";

it.layer(NodeServices.layer)("ClientTimingLog", (it) => {
  it.effect("writes one line per record with the session, server and app that sent it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filePath = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-client-timings-" }),
        "client-timings.ndjson",
      );
      const log = yield* ClientTimingLog.make(filePath);
      const app = { platform: "ios", version: "1.2.3", build: "45", updateId: "update-1" };
      const record = {
        span: "EnvironmentShellState.live",
        startedAtMs: 1_000,
        durationMs: 812.4,
        outcome: "ok" as const,
        failure: null,
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "a",
        attributes: { "shell.source": "http", "shell.threads": 120 },
      };
      const sessionId = AuthSessionId.make("session-1");

      yield* log.append({ sessionId, report: { app, records: [record] } });
      yield* log.append({ sessionId, report: { app, records: [] } });
      yield* log.append({
        sessionId,
        report: {
          app,
          records: [{ ...record, spanId: "b", outcome: "failed", failure: "timeout" }],
        },
      });

      const lines = (yield* fs.readFileString(filePath))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const server = { version: packageJson.version, load1m: expect.any(Number) };
      expect(lines).toEqual([
        { receivedAt: "1970-01-01T00:00:00.000Z", sessionId: "session-1", server, app, ...record },
        {
          receivedAt: "1970-01-01T00:00:00.000Z",
          sessionId: "session-1",
          server,
          app,
          ...record,
          spanId: "b",
          outcome: "failed",
          failure: "timeout",
        },
      ]);
    }),
  );
});
