import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

import {
  type ConnectionTimingRecord,
  formatConnectionTimingReport,
  makeConnectionTimingLog,
  makeConnectionTimingOutbox,
  recordConnectionTimings,
} from "./connection-timings-model";

const traced = <A, E>(
  effect: Effect.Effect<A, E>,
  log: ReturnType<typeof makeConnectionTimingLog>,
  outbox = makeConnectionTimingOutbox(10),
) =>
  effect.pipe(
    Effect.provideService(Tracer.Tracer, recordConnectionTimings(Tracer.nativeTracer, log, outbox)),
  );

const timing = (
  startedAtMs: number,
  environmentId: string | null = null,
): ConnectionTimingRecord => ({
  phase: { span: "environment.websocket.open", label: "Socket open", keep: [] },
  startedAtMs,
  durationMs: 1,
  outcome: "ok",
  failure: null,
  environmentId,
  traceId: "t",
  spanId: `s${startedAtMs}`,
  attributes: [],
});

describe("connection timings", () => {
  it.effect("records registered spans with their environment, outcome, and trace", () => {
    const log = makeConnectionTimingLog(10);
    const outbox = makeConnectionTimingOutbox(10);
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

      // Only records about an environment are sent, and clearing the screen keeps them queued.
      log.clear();
      expect(outbox.take("env-1", 10)).toEqual([initialSync, establish]);
    }).pipe((effect) => traced(effect, log, outbox));
  });

  it("keeps the last records to finish, latest start first", () => {
    const log = makeConnectionTimingLog(3);
    for (const startedAtMs of [1, 2, 3, 4, 5]) log.push(timing(startedAtMs), null);
    expect(log.records().map((entry) => entry.startedAtMs)).toEqual([5, 4, 3]);
    expect(log.records()).toBe(log.records());
    log.push(timing(0), null);
    expect(log.records().map((entry) => entry.startedAtMs)).toEqual([5, 4, 0]);
    log.clear();
    expect(log.records()).toEqual([]);
  });

  it("queues each environment's newest records and returns an unsent batch ahead of newer ones", () => {
    const outbox = makeConnectionTimingOutbox(3);
    const started = (records: ReadonlyArray<ConnectionTimingRecord>) =>
      records.map((record) => record.startedAtMs);
    for (const startedAtMs of [1, 2, 3, 4]) outbox.enqueue(timing(startedAtMs, "env-1"));
    outbox.enqueue(timing(10, "env-2"));

    const batch = outbox.take("env-1", 2);
    expect(started(batch)).toEqual([2, 3]);
    outbox.enqueue(timing(5, "env-1"));
    outbox.requeue("env-1", batch);
    expect(started(outbox.take("env-1", 10))).toEqual([3, 4, 5]);
    expect(started(outbox.take("env-2", 10))).toEqual([10]);
    expect(outbox.take("env-1", 10)).toEqual([]);
  });

  it("formats one greppable line per record", () => {
    const report = formatConnectionTimingReport(
      [
        {
          phase: {
            span: "EnvironmentShellState.live",
            label: "Thread list live",
            keep: [
              "shell.resume",
              "shell.source",
              "shell.cached",
              "shell.threads",
              "shell.projects",
            ],
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
