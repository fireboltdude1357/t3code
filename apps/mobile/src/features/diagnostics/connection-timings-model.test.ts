import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

import {
  type ConnectionTimingRecord,
  formatConnectionTimingReport,
  makeConnectionTimingLog,
  recordConnectionTimings,
} from "./connection-timings-model";

const traced = <A, E>(
  effect: Effect.Effect<A, E>,
  log: ReturnType<typeof makeConnectionTimingLog>,
) =>
  effect.pipe(
    Effect.provideService(Tracer.Tracer, recordConnectionTimings(Tracer.nativeTracer, log)),
  );

describe("connection timings", () => {
  it.effect("records registered spans with their environment, outcome, and trace", () => {
    const log = makeConnectionTimingLog(10);
    return Effect.gen(function* () {
      yield* Effect.void.pipe(
        Effect.withSpan("environment.initialSync"),
        Effect.withSpan("ConnectionDriver.connectOverRoutes"),
        Effect.withSpan("ConnectionDriver.connect", {
          attributes: { "connection.environment.id": "env-1" },
        }),
      );
      // Outside a connection attempt, initialSync is a subscription replay.
      yield* Effect.void.pipe(Effect.withSpan("environment.initialSync"));
      yield* Effect.withSpan("unregistered.span")(Effect.void);
      yield* Effect.void.pipe(
        Effect.withSpan("EnvironmentSupervisor.establish", {
          attributes: {
            "environment.id": "env-1",
            "environment.label": "Desk",
            "connection.attempt": 2,
            "connection.outcome": "timeout",
          },
        }),
      );
      yield* Effect.fail({ _tag: "RemoteUnavailable" }).pipe(
        Effect.withSpan("clientRuntime.state.executeAuthenticatedEnvironmentHttpRequest"),
        Effect.ignore,
      );

      const [request, establish, initialSync, ...rest] = log.records();
      expect(rest).toEqual([]);
      expect(initialSync).toMatchObject({
        phase: { span: "environment.initialSync" },
        outcome: "ok",
        environmentId: "env-1",
      });
      expect(initialSync?.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(establish).toMatchObject({
        outcome: "failed",
        failure: "timeout",
        attributes: [["connection.attempt", 2]],
      });
      expect(request).toMatchObject({ outcome: "failed", failure: "RemoteUnavailable" });
      expect(log.labelFor("env-1")).toBe("Desk");
    }).pipe((effect) => traced(effect, log));
  });

  it("keeps only the newest records, newest first", () => {
    const log = makeConnectionTimingLog(3);
    const record = (startedAtMs: number): ConnectionTimingRecord => ({
      phase: { span: "environment.websocket.open", label: "Socket open", keep: [] },
      startedAtMs,
      durationMs: 1,
      outcome: "ok",
      failure: null,
      environmentId: null,
      traceId: "t",
      spanId: `s${startedAtMs}`,
      attributes: [],
    });
    for (const startedAtMs of [1, 2, 3, 4, 5]) log.push(record(startedAtMs), null);
    expect(log.records().map((entry) => entry.startedAtMs)).toEqual([5, 4, 3]);
    expect(log.records()).toBe(log.records());
    log.clear();
    expect(log.records()).toEqual([]);
  });

  it("formats one greppable line per record", () => {
    const report = formatConnectionTimingReport(
      [
        {
          phase: {
            span: "EnvironmentShellState.live",
            label: "Thread list live",
            keep: ["shell.source", "shell.cached", "shell.threads", "shell.projects"],
          },
          startedAtMs: Date.UTC(2026, 9, 31, 17, 44, 12, 345),
          durationMs: 812.4,
          outcome: "ok",
          failure: null,
          environmentId: "env-1",
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "a",
          attributes: [
            ["shell.source", "http"],
            ["shell.threads", 120],
          ],
        },
        {
          phase: {
            span: "ConnectionDriver.checkRoute",
            label: "Route check",
            keep: ["connection.route.kind", "connection.route.check"],
          },
          startedAtMs: Date.UTC(2026, 9, 31, 17, 44, 11, 0),
          durationMs: 3000,
          outcome: "failed",
          failure: "timeout",
          environmentId: "env-2",
          traceId: "1bf7651916cd43dd8448eb211c80319c",
          spanId: "b",
          attributes: [],
        },
      ],
      (environmentId) => (environmentId === "env-1" ? "Desk" : null),
      { version: "1.2.3", build: "45" },
    );
    expect(report).toBe(
      [
        "T3 Code 1.2.3 (45) connection timings, newest first",
        "2026-10-31T17:44:12.345Z Desk (env-1) Thread list live [EnvironmentShellState.live] 812.4ms ok shell.source=http shell.threads=120 trace=0af7651916cd43dd8448eb211c80319c",
        "2026-10-31T17:44:11.000Z ? (env-2) Route check [ConnectionDriver.checkRoute] 3000ms failed:timeout trace=1bf7651916cd43dd8448eb211c80319c",
      ].join("\n"),
    );
  });
});
