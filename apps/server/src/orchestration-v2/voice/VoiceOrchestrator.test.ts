import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2RuntimeRequest,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadShell,
  type Project,
  type VoiceSessionEvent,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import type { ProviderAdapterV2RealtimeCall } from "../ProviderAdapter.ts";
import { ThreadManagementService } from "../ThreadManagementService.ts";
import {
  layer as orchestratorLayer,
  ROTATE_AFTER,
  VoiceOrchestrator,
} from "./VoiceOrchestrator.ts";
import * as VoiceSessionRegistry from "./VoiceSessionRegistry.ts";
import { type PreparedSessionThread, VoiceSessionService } from "./VoiceSessionService.ts";
import { layer as voiceStoreLayer, VoiceStore } from "./VoiceStore.ts";

const workThreadId = ThreadId.make("thread-work");
const voiceProjectId = ProjectId.make("project-voice");

// Only the fields the orchestrator reads.
const workShell = {
  id: workThreadId,
  projectId: ProjectId.make("project-work"),
  title: "Fix login",
  archivedAt: null,
  status: "running",
  updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
  lineage: { relationshipToParent: null },
} as unknown as OrchestrationV2ThreadShell;

const completedRun = {
  type: "run.updated",
  threadId: workThreadId,
  payload: { id: RunId.make("run-1"), threadId: workThreadId, status: "completed" },
} as OrchestrationV2DomainEvent;

const approvalRequestId = RuntimeRequestId.make("request-1");
const pendingApproval = {
  type: "runtime-request.updated",
  threadId: workThreadId,
  payload: {
    id: approvalRequestId,
    kind: "command",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: "provider-session" },
  },
} as unknown as OrchestrationV2DomainEvent;

/**
 * Builds the orchestrator on the real store and registry, with fakes for the
 * thread, project and session services. Returns the recorders the tests read.
 */
const makeHarness = Effect.gen(function* () {
  const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const requests = yield* Ref.make<ReadonlyArray<OrchestrationV2RuntimeRequest>>([]);
  const archivedAt = yield* Ref.make<DateTime.Utc | null>(null);
  const prepared = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const released = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const speech = yield* Ref.make<ReadonlyArray<string>>([]);
  const holdSpeech = yield* Ref.make(false);
  const speechStarted = yield* Queue.unbounded<string>();
  const speechDone = yield* Queue.unbounded<string>();
  const releaseSpeech = yield* Deferred.make<void>();
  const holdCall = yield* Ref.make(false);
  const callStarted = yield* Queue.unbounded<ThreadId>();
  const releaseCall = yield* Deferred.make<void>();
  const holdRequestQuery = yield* Ref.make(false);
  const requestQueryStarted = yield* Queue.unbounded<void>();
  const releaseRequestQuery = yield* Deferred.make<void>();
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);

  const store = Layer.effect(
    VoiceStore,
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      return VoiceStore.of({
        ...store,
        pendingRequestNotices: (limit) =>
          Effect.gen(function* () {
            if (yield* Ref.getAndSet(holdRequestQuery, false)) {
              yield* Queue.offer(requestQueryStarted, undefined);
              yield* Deferred.await(releaseRequestQuery);
            }
            return yield* store.pendingRequestNotices(limit);
          }),
      });
    }),
  ).pipe(Layer.provide(voiceStoreLayer));

  const fakeCall = (sessionThreadId: ThreadId): ProviderAdapterV2RealtimeCall => ({
    sdpAnswer: `answer:${sessionThreadId}`,
    ended: Effect.never,
    stop: Effect.void,
    appendText: () => Effect.void,
    appendSpeech: (text) =>
      Effect.gen(function* () {
        yield* Queue.offer(speechStarted, text);
        if (yield* Ref.get(holdSpeech)) yield* Deferred.await(releaseSpeech);
        yield* Ref.update(speech, (current) => [...current, text]);
        yield* Queue.offer(speechDone, text);
      }),
  });

  const sessionService = Layer.mock(VoiceSessionService)({
    prepare: () =>
      Ref.modify(prepared, (current): [PreparedSessionThread, ReadonlyArray<ThreadId>] => {
        const sessionThreadId = ThreadId.make(`session-${current.length + 1}`);
        return [
          {
            sessionThreadId,
            providerThread: {
              id: `provider-${sessionThreadId}`,
            } as unknown as OrchestrationV2ProviderThread,
            startRealtimeCall: () =>
              Effect.gen(function* () {
                if (yield* Ref.getAndSet(holdCall, false)) {
                  yield* Queue.offer(callStarted, sessionThreadId);
                  yield* Deferred.await(releaseCall);
                }
                return fakeCall(sessionThreadId);
              }),
          },
          [...current, sessionThreadId],
        ];
      }),
    release: (sessionThreadId) => Ref.update(released, (current) => [...current, sessionThreadId]),
  });

  const threadManagement = Layer.mock(ThreadManagementService)({
    streamDomainEvents: Stream.fromQueue(domainEvents).pipe(
      Stream.tap((event) =>
        event.type === "runtime-request.updated"
          ? Ref.update(requests, (current) => [
              ...current.filter((request) => request.id !== event.payload.id),
              { ...event.payload, threadId: event.threadId },
            ])
          : Effect.void,
      ),
    ),
    getThreadShell: (threadId) =>
      Ref.get(archivedAt).pipe(
        Effect.map((archivedAt) =>
          threadId === workThreadId ? { ...workShell, archivedAt } : null,
        ),
      ),
    getThreadRecords: () =>
      Ref.get(requests).pipe(
        Effect.map(
          (runtimeRequests) =>
            ({
              runtimeRequests,
              turnItems: [
                { type: "approval_request", requestId: approvalRequestId, prompt: "rm -rf build/" },
              ],
            }) as never,
        ),
      ),
    dispatch: (command) =>
      Ref.update(dispatched, (current) => [...current, command]).pipe(
        Effect.as({ sequence: 1, storedEvents: [] } as never),
      ),
    getShellSnapshot: () =>
      Effect.all([Ref.get(requests), Ref.get(archivedAt)]).pipe(
        Effect.map(([current, archivedAt]) => ({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [
            {
              ...workShell,
              archivedAt,
              pendingRuntimeRequest:
                current.find((request) => request.status === "pending") ?? null,
            },
          ],
          archivedThreads: [],
        })),
      ),
  });

  const projects = Layer.mock(ProjectService)({
    bootstrap: () =>
      Effect.succeed({ project: { id: voiceProjectId } as unknown as Project, created: true }),
    listShells: () => Effect.succeed([]),
  });

  const layer = orchestratorLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        store,
        VoiceSessionRegistry.layer,
        sessionService,
        threadManagement,
        projects,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-voice-orchestrator-" }),
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    layer,
    domainEvents,
    requests,
    archivedAt,
    prepared,
    released,
    speech,
    dispatched,
    holdSpeech,
    speechStarted,
    speechDone,
    releaseSpeech,
    holdCall,
    callStarted,
    releaseCall,
    holdRequestQuery,
    requestQueryStarted,
    releaseRequestQuery,
  };
});

type Harness = Effect.Success<typeof makeHarness>;

/** Runs `body` with the orchestrator built under the test's TestClock. */
const withOrchestrator = <A, E, R>(body: (harness: Harness) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    return yield* body(harness).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.scoped);

/** Lets forked fibers and real I/O (SQLite, mkdir) catch up. */
const settle = TestClock.withLive(Effect.sleep(Duration.millis(20)));

/** Opens a generation and forwards its events to a queue the test reads. */
const openCall = Effect.gen(function* () {
  const orchestrator = yield* VoiceOrchestrator;
  const events = yield* Queue.unbounded<VoiceSessionEvent>();
  const fiber = yield* orchestrator
    .open({ sdpOffer: "v=0 offer", supportsRequestNotices: true })
    .pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
  const answer = yield* Queue.take(events);
  assert.strictEqual(answer.type, "answer");
  const snapshot = yield* Queue.take(events);
  assert.strictEqual(snapshot.type, "request_notices");
  return {
    events,
    fiber,
    snapshot: snapshot as Extract<VoiceSessionEvent, { type: "request_notices" }>,
    answer: answer as Extract<VoiceSessionEvent, { type: "answer" }>,
  };
});

/** Takes events until one of `type` arrives. */
const takeUntilType = <T extends VoiceSessionEvent["type"]>(
  events: Queue.Queue<VoiceSessionEvent>,
  type: T,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(events);
      if (event.type === type) return event as Extract<VoiceSessionEvent, { type: T }>;
    }
  });

it.effect("announces a completed run once, in a pause, and marks it delivered", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      const { events } = yield* openCall;

      yield* Queue.offer(harness.domainEvents, completedRun);
      yield* settle;
      for (let second = 0; second < 20 && (yield* Ref.get(harness.speech)).length === 0; second++) {
        yield* TestClock.adjust("1 second");
        yield* settle;
      }

      const speech = yield* Ref.get(harness.speech);
      assert.strictEqual(speech.length, 1);
      assert.include(speech[0], "Fix login finished.");
      const notice = yield* takeUntilType(events, "notice");
      assert.strictEqual(notice.notice.threadId, workThreadId);
      assert.strictEqual(notice.notice.kind, "completed");
      assert.deepStrictEqual(yield* store.undeliveredNotices(10), []);
      assert.strictEqual((yield* store.listAgenda({ status: "open" })).length, 1);

      // The same event again is deduped.
      yield* Queue.offer(harness.domainEvents, completedRun);
      yield* settle;
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      assert.strictEqual((yield* Ref.get(harness.speech)).length, 1);
      assert.strictEqual(yield* Queue.size(events), 0);
    }),
  ),
);

it.effect("a second open rotates the first generation out and releases its thread", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const first = yield* openCall;
      const second = yield* openCall;

      assert.isAbove(second.answer.generation, first.answer.generation);
      assert.notStrictEqual(second.answer.sessionThreadId, first.answer.sessionThreadId);
      const ended = yield* takeUntilType(first.events, "ended");
      assert.strictEqual(ended.reason, "rotated");
      yield* Fiber.join(first.fiber);
      yield* settle;
      assert.deepStrictEqual(yield* Ref.get(harness.released), [first.answer.sessionThreadId]);
    }),
  ),
);

it.effect("confirmations resolve from the phone, or false after two minutes", () =>
  withOrchestrator(() =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      const { events } = yield* openCall;
      const confirm = (title: string) =>
        orchestrator
          .requestConfirmation({ action: "launch", title, detail: "Start a new thread." })
          .pipe(Effect.forkScoped);

      const approvedFiber = yield* confirm("Launch A");
      const shown = yield* takeUntilType(events, "confirm");
      assert.strictEqual(shown.request.title, "Launch A");
      assert.deepStrictEqual(
        yield* orchestrator.respond({ requestId: shown.request.id, approved: true }),
        { accepted: true },
      );
      assert.isTrue(yield* Fiber.join(approvedFiber));
      const resolved = yield* takeUntilType(events, "confirm_resolved");
      assert.deepStrictEqual(resolved, {
        type: "confirm_resolved",
        requestId: shown.request.id,
        approved: true,
      });
      // Answered already, so a second tap is refused.
      assert.deepStrictEqual(
        yield* orchestrator.respond({ requestId: shown.request.id, approved: false }),
        { accepted: false },
      );

      const timedOutFiber = yield* confirm("Launch B");
      const pending = yield* takeUntilType(events, "confirm");
      yield* TestClock.adjust("2 minutes");
      assert.isFalse(yield* Fiber.join(timedOutFiber));
      const expired = yield* takeUntilType(events, "confirm_resolved");
      assert.strictEqual(expired.requestId, pending.request.id);
      assert.isFalse(expired.approved);
    }),
  ),
);

it.effect("prewarms the next session thread and the next open uses it", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const first = yield* openCall;
      assert.strictEqual((yield* Ref.get(harness.prepared)).length, 1);

      yield* TestClock.adjust(Duration.subtract(ROTATE_AFTER, Duration.minutes(2)));
      yield* settle;
      const afterPrewarm = yield* Ref.get(harness.prepared);
      assert.strictEqual(afterPrewarm.length, 2);
      assert.strictEqual(yield* Queue.size(first.events), 0);

      yield* TestClock.adjust("2 minutes");
      yield* takeUntilType(first.events, "rotate");

      const second = yield* openCall;
      assert.strictEqual((yield* Ref.get(harness.prepared)).length, 2);
      assert.strictEqual(second.answer.sessionThreadId, afterPrewarm[1]);
      assert.strictEqual((yield* takeUntilType(first.events, "ended")).reason, "rotated");
    }),
  ),
);

it.effect("approving a runtime request on the phone dispatches the response", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      const { events } = yield* openCall;
      yield* Queue.offer(harness.domainEvents, pendingApproval);
      const confirm = yield* takeUntilType(events, "confirm");
      assert.strictEqual(confirm.request.action, "runtime_approval");
      assert.strictEqual(confirm.request.detail, "rm -rf build/");

      yield* orchestrator.respond({ requestId: confirm.request.id, approved: true });
      yield* takeUntilType(events, "confirm_resolved");
      yield* settle;
      const response = (yield* Ref.get(harness.dispatched)).find(
        (command) => command.type === "runtime-request.respond",
      );
      assert.deepInclude(response, {
        type: "runtime-request.respond",
        threadId: workThreadId,
        requestId: approvalRequestId,
        decision: "accept",
      });
    }),
  ),
);

const inputEvent = (
  requestId: string,
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
) =>
  ({
    type: "runtime-request.updated",
    threadId: workThreadId,
    payload: {
      id: RuntimeRequestId.make(requestId),
      threadId: workThreadId,
      kind: "user_input",
      status,
      responseCapability: { type: "live", providerSessionId: "provider-session" },
    },
  }) as unknown as Extract<OrchestrationV2DomainEvent, { type: "runtime-request.updated" }>;

it.effect(
  "clears an answered question immediately and shows a later question on the same thread",
  () =>
    withOrchestrator((harness) =>
      Effect.gen(function* () {
        const { events } = yield* openCall;
        yield* Queue.offer(harness.domainEvents, inputEvent("question-1"));
        const pending = yield* takeUntilType(events, "request_notices");
        assert.deepStrictEqual(
          pending.notices.map((notice) => notice.requestId),
          [RuntimeRequestId.make("question-1")],
        );
        assert.strictEqual(pending.notices[0]?.kind, "input");
        assert.deepStrictEqual(yield* Ref.get(harness.speech), []);

        yield* Queue.offer(harness.domainEvents, inputEvent("question-1", "resolved"));
        assert.deepStrictEqual((yield* takeUntilType(events, "request_notices")).notices, []);
        const store = yield* VoiceStore;
        assert.deepStrictEqual(yield* store.undeliveredNotices(10), []);

        yield* Queue.offer(harness.domainEvents, inputEvent("question-2"));
        assert.deepStrictEqual(
          (yield* takeUntilType(events, "request_notices")).notices.map(
            (notice) => notice.requestId,
          ),
          [RuntimeRequestId.make("question-2")],
        );
      }),
    ),
);

it.effect("reconnect reconciles a resolution missing from the event feed", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const first = yield* openCall;
      const pending = inputEvent("question-offline");
      yield* Queue.offer(harness.domainEvents, pending);
      yield* takeUntilType(first.events, "request_notices");
      const stillPending = yield* openCall;
      assert.deepStrictEqual(
        stillPending.snapshot.notices.map((notice) => notice.requestId),
        [RuntimeRequestId.make("question-offline")],
      );
      yield* Ref.set(harness.requests, [{ ...pending.payload, status: "resolved" }]);
      const reconnected = yield* openCall;
      assert.deepStrictEqual(reconnected.snapshot.notices, []);
      const store = yield* VoiceStore;
      assert.deepStrictEqual(yield* store.pendingRequestNotices(10), []);
      assert.deepStrictEqual(yield* store.undeliveredNotices(10), []);
    }),
  ),
);

it.effect("reconnect restores an unarchived pending question and settlement still clears it", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      const first = yield* openCall;
      yield* Queue.offer(harness.domainEvents, inputEvent("question-archived"));
      const pending = yield* takeUntilType(first.events, "request_notices");
      assert.strictEqual(pending.notices[0]?.kind, "input");
      assert.strictEqual(pending.notices[0]?.requestId, RuntimeRequestId.make("question-archived"));

      const connected = yield* openCall;
      assert.deepStrictEqual(connected.snapshot.notices, pending.notices);
      assert.deepStrictEqual(yield* store.undeliveredNotices(10), []);

      yield* Ref.set(harness.archivedAt, DateTime.makeUnsafe("2026-10-01T00:01:00.000Z"));
      const archived = yield* openCall;
      assert.deepStrictEqual(archived.snapshot.notices, []);
      assert.deepStrictEqual(yield* store.pendingRequestNotices(10), []);

      yield* Ref.set(harness.archivedAt, null);
      const restored = yield* openCall;
      assert.deepStrictEqual(restored.snapshot.notices, pending.notices);
      assert.deepStrictEqual(yield* store.undeliveredNotices(10), []);

      yield* Queue.offer(harness.domainEvents, inputEvent("question-archived", "resolved"));
      assert.deepStrictEqual(
        (yield* takeUntilType(restored.events, "request_notices")).notices,
        [],
      );
      const settled = yield* openCall;
      assert.deepStrictEqual(settled.snapshot.notices, []);
      assert.deepStrictEqual(yield* store.pendingRequestNotices(10), []);
    }),
  ),
);

it.effect("a legacy replacement never receives an in-flight request snapshot", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      const first = yield* openCall;
      const legacyEvents = yield* Queue.unbounded<VoiceSessionEvent>();
      yield* Ref.set(harness.holdCall, true);
      yield* orchestrator.open({ sdpOffer: "v=0 legacy replacement" }).pipe(
        Stream.runForEach((event) => Queue.offer(legacyEvents, event)),
        Effect.forkScoped,
      );
      yield* Queue.take(harness.callStarted);

      yield* Ref.set(harness.holdRequestQuery, true);
      yield* Queue.offer(harness.domainEvents, inputEvent("question-generation-race"));
      yield* Queue.take(harness.requestQueryStarted);
      yield* Deferred.succeed(harness.releaseCall, undefined);
      assert.strictEqual((yield* takeUntilType(first.events, "ended")).reason, "rotated");
      yield* Deferred.succeed(harness.releaseRequestQuery, undefined);
      assert.strictEqual((yield* Queue.take(legacyEvents)).type, "answer");

      const confirmation = yield* orchestrator
        .requestConfirmation({
          action: "launch",
          title: "Launch after replacement",
          detail: "Start a new thread.",
        })
        .pipe(Effect.forkScoped);
      const next = yield* Queue.take(legacyEvents);
      assert.strictEqual(next.type, "confirm");
      if (next.type !== "confirm") return;
      yield* orchestrator.respond({ requestId: next.request.id, approved: false });
      assert.isFalse(yield* Fiber.join(confirmation));
      assert.strictEqual((yield* Queue.take(legacyEvents)).type, "confirm_resolved");
      const store = yield* VoiceStore;
      assert.deepStrictEqual(
        (yield* store.pendingRequestNotices(10)).map((notice) => notice.requestId),
        [RuntimeRequestId.make("question-generation-race")],
      );
    }),
  ),
);

it.effect("a delayed speech completion cannot restore an answered question card", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      yield* Ref.set(harness.holdSpeech, true);
      const { events } = yield* openCall;
      yield* Queue.offer(harness.domainEvents, inputEvent("question-race"));
      yield* takeUntilType(events, "request_notices");
      for (let index = 0; index < 7; index++) {
        yield* Queue.offer(harness.domainEvents, {
          ...completedRun,
          payload: { ...completedRun.payload, id: RunId.make(`race-run-${index}`) },
        } as OrchestrationV2DomainEvent);
      }
      yield* TestClock.adjust("10 seconds");
      yield* Queue.take(harness.speechStarted);
      yield* Queue.takeAll(events);

      yield* Queue.offer(harness.domainEvents, inputEvent("question-race", "resolved"));
      assert.deepStrictEqual((yield* takeUntilType(events, "request_notices")).notices, []);
      yield* Deferred.succeed(harness.releaseSpeech, undefined);
      yield* Queue.take(harness.speechDone);
      for (let index = 0; index < 7; index++) {
        assert.strictEqual((yield* takeUntilType(events, "notice")).notice.kind, "completed");
      }
      assert.strictEqual(yield* Queue.size(events), 0);
      const store = yield* VoiceStore;
      assert.deepStrictEqual(yield* store.pendingRequestNotices(10), []);
    }),
  ),
);

it.effect(
  "keeps the original notice protocol for clients that do not opt into request snapshots",
  () =>
    withOrchestrator((harness) =>
      Effect.gen(function* () {
        const orchestrator = yield* VoiceOrchestrator;
        const events = yield* Queue.unbounded<VoiceSessionEvent>();
        yield* orchestrator.open({ sdpOffer: "v=0 legacy offer" }).pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        assert.strictEqual((yield* Queue.take(events)).type, "answer");
        yield* Queue.offer(harness.domainEvents, inputEvent("legacy-client-question"));
        for (let index = 0; index < 7; index++) {
          yield* Queue.offer(harness.domainEvents, {
            ...completedRun,
            payload: { ...completedRun.payload, id: RunId.make(`legacy-run-${index}`) },
          } as OrchestrationV2DomainEvent);
        }
        yield* TestClock.adjust("10 seconds");
        const first = yield* Queue.take(events);
        assert.strictEqual(first.type, "notice");
        if (first.type === "notice") assert.strictEqual(first.notice.kind, "input");
      }),
    ),
);
