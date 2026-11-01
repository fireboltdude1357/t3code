import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import {
  CLIENT_TIMING_REPORT_MAX_RECORDS,
  type ClientTimingReport,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  type ConnectionTimingOutbox,
  connectionTimingOutbox,
  toClientTimingRecord,
} from "./connection-timings-model";

const SEND_DEBOUNCE = "5 seconds";

type DrainResult = "idle" | "failed" | "stopped";

export function sendWhileConnected<E, R>(
  environmentId: string,
  outbox: ConnectionTimingOutbox,
  send: (records: ClientTimingReport["records"]) => Effect.Effect<void, E, R>,
): Stream.Stream<DrainResult, never, R> {
  const drain = Effect.gen(function* () {
    while (true) {
      const batch = outbox.take(environmentId, CLIENT_TIMING_REPORT_MAX_RECORDS);
      if (batch.length === 0) return "idle" as const;
      const exit = yield* send(batch.map(toClientTimingRecord)).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.sync(() => outbox.requeue(environmentId, batch)),
        ),
        Effect.exit,
      );
      // An older server answers a method it does not know with a defect.
      if (Exit.isFailure(exit)) return Cause.hasDies(exit.cause) ? "stopped" : "failed";
    }
  });
  const enqueued = Stream.callback<void>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          outbox.subscribe(environmentId, () => Queue.offerUnsafe(queue, undefined)),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    { bufferSize: 1, strategy: "sliding" },
  );
  return Stream.concat(Stream.succeed(undefined), enqueued).pipe(
    Stream.debounce(SEND_DEBOUNCE),
    Stream.mapEffect(() => drain),
    Stream.takeUntil((result) => result === "stopped"),
  );
}

const sessionChanges = Stream.unwrap(
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    return Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(supervisor.session)),
      SubscriptionRef.changes(supervisor.session),
    );
  }),
).pipe(
  Stream.changesWith(
    (previous, current) => Option.getOrNull(previous) === Option.getOrNull(current),
  ),
);

export const layer = (app: ClientTimingReport["app"]) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const followed = new Set<EnvironmentId>();
      const send = (records: ClientTimingReport["records"]) =>
        // The report's own request would otherwise record another timing to send.
        request(WS_METHODS.serverReportClientTimings, { app, records }).pipe(
          Effect.withTracerEnabled(false),
        );
      const follow = (environmentId: EnvironmentId) =>
        registry
          .followStream(
            environmentId,
            sessionChanges.pipe(
              Stream.switchMap((session) =>
                Option.isSome(session)
                  ? sendWhileConnected(environmentId, connectionTimingOutbox, send)
                  : Stream.empty,
              ),
            ),
          )
          .pipe(Stream.runDrain);
      yield* Stream.concat(
        Stream.fromEffect(SubscriptionRef.get(registry.entries)),
        SubscriptionRef.changes(registry.entries),
      ).pipe(
        Stream.runForEach((entries) =>
          Effect.forEach(
            entries.keys(),
            (environmentId) => {
              if (followed.has(environmentId)) return Effect.void;
              followed.add(environmentId);
              return Effect.forkScoped(follow(environmentId));
            },
            { discard: true },
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );
