import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  type ConnectionTimingRecord,
  makeConnectionTimingOutbox,
} from "./connection-timings-model";
import { sendWhileConnected } from "./connection-timings-sender";

const timing = (startedAtMs: number): ConnectionTimingRecord => ({
  phase: { span: "environment.websocket.open", label: "Socket open", keep: [] },
  startedAtMs,
  durationMs: 1,
  outcome: "ok",
  failure: null,
  environmentId: "env-1",
  traceId: "t",
  spanId: `s${startedAtMs}`,
  attributes: [],
});

it.effect(
  "sends after a quiet period, keeps a failed batch, and stops when the server rejects the method",
  () =>
    Effect.gen(function* () {
      const outbox = makeConnectionTimingOutbox(200);
      for (let index = 0; index < 60; index++) outbox.enqueue(timing(index));
      const sent = yield* Queue.unbounded<number>();
      const responses = [
        Effect.fail("offline"),
        Effect.void,
        Effect.die("Unknown request tag: server.reportClientTimings"),
      ];
      const fiber = yield* sendWhileConnected("env-1", outbox, (records) =>
        Effect.suspend(() => {
          Queue.offerUnsafe(sent, records.length);
          return responses.shift() ?? Effect.void;
        }),
      ).pipe(Stream.runCollect, Effect.forkChild);

      yield* TestClock.adjust("4 seconds");
      expect(yield* Queue.size(sent)).toBe(0);
      yield* TestClock.adjust("1 second");
      expect(yield* Queue.take(sent)).toBe(50);

      outbox.enqueue(timing(60));
      yield* TestClock.adjust("5 seconds");
      expect(yield* Queue.takeN(sent, 2)).toEqual([50, 11]);

      expect(yield* Fiber.join(fiber)).toEqual(["failed", "stopped"]);
      expect(outbox.take("env-1", 50).map((record) => record.startedAtMs)).toEqual(
        Array.from({ length: 11 }, (_, index) => 50 + index),
      );
    }),
);
