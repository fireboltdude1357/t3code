import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2RuntimeRequest,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadShell,
  type Project,
  VoiceSessionEvent,
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
import * as Schema from "effect/Schema";
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
import { confirmationReadback } from "./VoiceConfirmation.ts";
import * as VoiceSessionRegistry from "./VoiceSessionRegistry.ts";
import {
  type PreparedSessionThread,
  VoiceSessionError,
  VoiceSessionService,
} from "./VoiceSessionService.ts";
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
} as unknown as Extract<OrchestrationV2DomainEvent, { type: "runtime-request.updated" }>;

/**
 * Builds the orchestrator on the real store and registry, with fakes for the
 * thread, project and session services. Returns the recorders the tests read.
 */
const makeHarness = Effect.gen(function* () {
  const prepareWork = yield* Ref.make<Effect.Effect<void, VoiceSessionError>>(Effect.void);
  const briefingWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const realtimeWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const transcriptWork = yield* Ref.make<
    NonNullable<Parameters<PreparedSessionThread["startRealtimeCall"]>[0]["onTranscript"]>
  >(() => Effect.void);
  const activityWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const stopped = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const requests = yield* Ref.make<ReadonlyArray<OrchestrationV2RuntimeRequest>>([]);
  const approvalPrompt = yield* Ref.make("rm -rf build/");
  const projectDomainRequests = yield* Ref.make(true);
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
  const commandDispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();

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
    stop: Ref.update(stopped, (current) => [...current, sessionThreadId]),
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
      Ref.get(prepareWork).pipe(
        Effect.flatten,
        Effect.andThen(
          Ref.modify(prepared, (current): [PreparedSessionThread, ReadonlyArray<ThreadId>] => {
            const sessionThreadId = ThreadId.make(`session-${current.length + 1}`);
            return [
              {
                sessionThreadId,
                providerThread: {
                  id: `provider-${sessionThreadId}`,
                } as unknown as OrchestrationV2ProviderThread,
                startRealtimeCall: (input) =>
                  Effect.gen(function* () {
                    yield* Ref.set(transcriptWork, input.onTranscript ?? (() => Effect.void));
                    yield* Ref.set(activityWork, input.onActivity ?? Effect.void);
                    if (yield* Ref.getAndSet(holdCall, false)) {
                      yield* Queue.offer(callStarted, sessionThreadId);
                      yield* Deferred.await(releaseCall);
                    }
                    yield* Ref.get(realtimeWork).pipe(Effect.flatten);
                    return fakeCall(sessionThreadId);
                  }),
              },
              [...current, sessionThreadId],
            ];
          }),
        ),
      ),
    release: (sessionThreadId) => Ref.update(released, (current) => [...current, sessionThreadId]),
  });

  const threadManagement = Layer.mock(ThreadManagementService)({
    streamDomainEvents: Stream.fromQueue(domainEvents).pipe(
      Stream.tap((event) =>
        Effect.gen(function* () {
          if (event.type === "runtime-request.updated" && (yield* Ref.get(projectDomainRequests))) {
            yield* Ref.update(requests, (current) => [
              ...current.filter((request) => request.id !== event.payload.id),
              { ...event.payload, threadId: event.threadId },
            ]);
          }
        }),
      ),
    ),
    getThreadShell: (threadId) =>
      Ref.get(archivedAt).pipe(
        Effect.map((archivedAt) =>
          threadId === workThreadId ? { ...workShell, archivedAt } : null,
        ),
      ),
    getThreadRecords: () =>
      Effect.all([Ref.get(requests), Ref.get(approvalPrompt)]).pipe(
        Effect.map(
          ([runtimeRequests, prompt]) =>
            ({
              runtimeRequests,
              turnItems: [{ type: "approval_request", requestId: approvalRequestId, prompt }],
            }) as never,
        ),
      ),
    dispatch: (command) =>
      Ref.update(dispatched, (current) => [...current, command]).pipe(
        Effect.andThen(Queue.offer(commandDispatched, command)),
        Effect.as({ sequence: 1, storedEvents: [] } as never),
      ),
    getShellSnapshot: () =>
      Ref.get(briefingWork).pipe(
        Effect.flatten,
        Effect.andThen(Effect.all([Ref.get(requests), Ref.get(archivedAt)])),
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
    approvalPrompt,
    projectDomainRequests,
    archivedAt,
    prepared,
    released,
    transcriptWork,
    activityWork,
    prepareWork,
    briefingWork,
    realtimeWork,
    stopped,
    speech,
    dispatched,
    commandDispatched,
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

/** Starts consuming immediately, so tests can observe startup while work is blocked. */
const startCall = Effect.gen(function* () {
  const orchestrator = yield* VoiceOrchestrator;
  const events = yield* Queue.unbounded<VoiceSessionEvent>();
  const fiber = yield* orchestrator
    .open({ sdpOffer: "v=0 offer", startupProgress: true, supportsRequestNotices: true })
    .pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
  return { events, fiber };
});

/** Opens a generation, retaining startup events and the authoritative request snapshot. */
const openCall = Effect.gen(function* () {
  const { events, fiber } = yield* startCall;
  const startup: VoiceSessionEvent[] = [];
  let answer = yield* Queue.take(events);
  while (answer.type === "startup") {
    startup.push(answer);
    answer = yield* Queue.take(events);
  }
  assert.strictEqual(answer.type, "answer");
  const retiredConfirmations: Array<Extract<VoiceSessionEvent, { type: "confirm_resolved" }>> = [];
  let snapshot = yield* Queue.take(events);
  while (snapshot.type === "confirm_resolved") {
    retiredConfirmations.push(snapshot);
    snapshot = yield* Queue.take(events);
  }
  assert.strictEqual(snapshot.type, "request_notices");
  return {
    events,
    fiber,
    startup,
    retiredConfirmations,
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
      assert.deepStrictEqual(second.startup, [
        { type: "startup", stage: "preparing-session" },
        { type: "startup", stage: "briefing" },
        { type: "startup", stage: "starting-realtime" },
      ]);
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
  "an approval pending before the call gets a gate and dispatches only after approval",
  () =>
    withOrchestrator((harness) =>
      Effect.gen(function* () {
        const orchestrator = yield* VoiceOrchestrator;
        yield* Ref.set(harness.requests, [pendingApproval.payload]);
        const first = yield* openCall;
        assert.strictEqual(first.snapshot.notices[0]?.requestId, approvalRequestId);
        const confirm = yield* takeUntilType(first.events, "confirm");
        assert.strictEqual(confirm.request.action, "runtime_approval");
        assert.strictEqual(confirm.request.detail, "rm -rf build/");
        assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
        yield* orchestrator.respond({ requestId: confirm.request.id, approved: true });
        yield* takeUntilType(first.events, "confirm_resolved");
        assert.deepInclude(yield* Queue.take(harness.commandDispatched), {
          type: "runtime-request.respond",
          threadId: workThreadId,
          requestId: approvalRequestId,
          decision: "accept",
        });
      }),
    ),
);

it.effect(
  "post-live reconciliation and a pending event share one approval gate per generation",
  () =>
    withOrchestrator((harness) =>
      Effect.gen(function* () {
        yield* Ref.set(harness.requests, [pendingApproval.payload]);
        yield* Ref.set(harness.holdRequestQuery, true);
        const opening = yield* openCall.pipe(Effect.forkScoped);
        yield* Queue.take(harness.requestQueryStarted);
        yield* Queue.offer(harness.domainEvents, pendingApproval);
        yield* Deferred.succeed(harness.releaseRequestQuery, undefined);
        const first = yield* Fiber.join(opening);
        const remaining: VoiceSessionEvent[] = [];
        while (
          !remaining.some((event) => event.type === "confirm") ||
          !remaining.some((event) => event.type === "request_notices")
        ) {
          remaining.push(yield* Queue.take(first.events));
        }
        const confirm = remaining.find((event) => event.type === "confirm");
        assert.isDefined(confirm);
        if (confirm === undefined) return;
        const second = yield* openCall;
        const carried = yield* Queue.take(second.events);
        assert.strictEqual(carried.type, "confirm");
        if (carried.type !== "confirm") return;
        assert.notStrictEqual(carried.request.id, confirm.request.id);
        assert.deepStrictEqual(second.retiredConfirmations, [
          { type: "confirm_resolved", requestId: confirm.request.id, approved: false },
        ]);
        assert.strictEqual(remaining.filter((event) => event.type === "confirm").length, 1);
        assert.deepStrictEqual(yield* Queue.takeAll(first.events), [
          { type: "ended", reason: "rotated" },
        ]);
        const orchestrator = yield* VoiceOrchestrator;
        assert.deepStrictEqual(
          yield* orchestrator.respond({ requestId: confirm.request.id, approved: true }),
          { accepted: false },
        );
        assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
        yield* orchestrator.respond({ requestId: carried.request.id, approved: false });
        assert.strictEqual((yield* Queue.take(second.events)).type, "confirm_resolved");
        assert.strictEqual(yield* Queue.size(second.events), 0);
      }),
    ),
);

it.effect("a denied approval is not prompted again until reconnect", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      yield* Ref.set(harness.requests, [pendingApproval.payload]);
      const first = yield* openCall;
      const confirm = yield* takeUntilType(first.events, "confirm");
      yield* orchestrator.respond({ requestId: confirm.request.id, approved: false });
      yield* takeUntilType(first.events, "confirm_resolved");
      yield* Queue.offer(harness.domainEvents, pendingApproval);
      assert.strictEqual((yield* Queue.take(first.events)).type, "request_notices");
      const second = yield* openCall;
      const retried = yield* Queue.take(second.events);
      assert.strictEqual(retried.type, "confirm");
      if (retried.type !== "confirm") return;
      assert.notStrictEqual(retried.request.id, confirm.request.id);
      assert.deepStrictEqual(yield* Queue.takeAll(first.events), [
        { type: "ended", reason: "rotated" },
      ]);
      assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
    }),
  ),
);

it.effect("an expired approval is not prompted again until reconnect", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      yield* Ref.set(harness.requests, [pendingApproval.payload]);
      const first = yield* openCall;
      const confirm = yield* takeUntilType(first.events, "confirm");
      yield* TestClock.adjust("2 minutes");
      const resolved = yield* takeUntilType(first.events, "confirm_resolved");
      assert.isFalse(resolved.approved);
      yield* Queue.offer(harness.domainEvents, pendingApproval);
      assert.strictEqual((yield* Queue.take(first.events)).type, "request_notices");
      const second = yield* openCall;
      const retried = yield* Queue.take(second.events);
      assert.strictEqual(retried.type, "confirm");
      if (retried.type !== "confirm") return;
      assert.notStrictEqual(retried.request.id, confirm.request.id);
      assert.deepStrictEqual(yield* Queue.takeAll(first.events), [
        { type: "ended", reason: "rotated" },
      ]);
      assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
    }),
  ),
);

it.effect("settlement during setup prevents an approval prompt", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      yield* Ref.set(harness.requests, [pendingApproval.payload]);
      yield* Ref.set(harness.holdCall, true);
      const opening = yield* openCall.pipe(Effect.forkScoped);
      yield* Queue.take(harness.callStarted);
      yield* Ref.set(harness.requests, [{ ...pendingApproval.payload, status: "resolved" }]);
      yield* Deferred.succeed(harness.releaseCall, undefined);
      const first = yield* Fiber.join(opening);
      assert.deepStrictEqual(first.snapshot.notices, []);
      yield* Queue.offer(harness.domainEvents, inputEvent("receipt-question"));
      const receipt = yield* Queue.take(first.events);
      assert.strictEqual(receipt.type, "request_notices");
      const second = yield* openCall;
      assert.deepStrictEqual(
        second.snapshot.notices.map((notice) => notice.requestId),
        [RuntimeRequestId.make("receipt-question")],
      );
      assert.deepStrictEqual(yield* Queue.takeAll(first.events), [
        { type: "ended", reason: "rotated" },
      ]);
      assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
    }),
  ),
);

it.effect("settlement closes an approval gate and a stale pending event cannot restore it", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      yield* Ref.set(harness.requests, [pendingApproval.payload]);
      const first = yield* openCall;
      const confirm = yield* takeUntilType(first.events, "confirm");
      yield* Queue.offer(harness.domainEvents, {
        ...pendingApproval,
        payload: { ...pendingApproval.payload, status: "resolved" },
      });
      const cleared: VoiceSessionEvent[] = [];
      while (
        !cleared.some((event) => event.type === "request_notices") ||
        !cleared.some((event) => event.type === "confirm_resolved")
      ) {
        cleared.push(yield* Queue.take(first.events));
      }
      assert.deepInclude(cleared, { type: "request_notices", notices: [] });
      assert.deepInclude(cleared, {
        type: "confirm_resolved",
        requestId: confirm.request.id,
        approved: false,
      });
      assert.deepStrictEqual(
        yield* orchestrator.respond({ requestId: confirm.request.id, approved: true }),
        { accepted: false },
      );
      yield* Ref.set(harness.projectDomainRequests, false);
      yield* Queue.offer(harness.domainEvents, pendingApproval);
      yield* Ref.update(harness.requests, (requests) => [
        ...requests,
        inputEvent("receipt-question").payload,
      ]);
      yield* Queue.offer(harness.domainEvents, inputEvent("receipt-question"));
      assert.strictEqual((yield* Queue.take(first.events)).type, "request_notices");
      const second = yield* openCall;
      assert.deepStrictEqual(
        second.snapshot.notices.map((notice) => notice.requestId),
        [RuntimeRequestId.make("receipt-question")],
      );
      assert.deepStrictEqual(yield* Queue.takeAll(first.events), [
        { type: "ended", reason: "rotated" },
      ]);
      assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
    }),
  ),
);

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

it.effect("a slow older open preserves the newer generation's pending approval", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      const enteredRealtime = yield* Deferred.make<void>();
      const finishRealtime = yield* Deferred.make<void>();
      yield* Ref.set(
        harness.realtimeWork,
        Deferred.succeed(enteredRealtime, undefined).pipe(
          Effect.andThen(Deferred.await(finishRealtime)),
        ),
      );
      const older = yield* startCall;
      yield* Deferred.await(enteredRealtime);
      yield* Ref.set(harness.realtimeWork, Effect.void);
      const newer = yield* openCall;
      const executed = yield* Ref.make(0);
      yield* orchestrator.proposeAction({
        sessionThreadId: newer.answer.sessionThreadId,
        action: "launch",
        title: "Audit",
        detail: "Review the change",
        execute: Ref.update(executed, (count) => count + 1).pipe(Effect.as("Started Audit.")),
      });
      const { request } = yield* takeUntilType(newer.events, "confirm");

      yield* Deferred.succeed(finishRealtime, undefined);
      const olderAnswer = yield* takeUntilType(older.events, "answer");
      assert.isBelow(olderAnswer.generation, newer.answer.generation);
      assert.strictEqual((yield* takeUntilType(older.events, "ended")).reason, "rotated");
      yield* Fiber.join(older.fiber);
      assert.strictEqual(
        (yield* orchestrator.liveSession(newer.answer.sessionThreadId))._tag,
        "Some",
      );
      assert.deepStrictEqual(
        yield* orchestrator.pendingConfirmations(newer.answer.sessionThreadId),
        [request],
      );
      assert.strictEqual(yield* Ref.get(executed), 0);
      assert.deepStrictEqual(
        yield* orchestrator.respond({ requestId: request.id, approved: true }),
        { accepted: true },
      );
      assert.deepStrictEqual(yield* takeUntilType(newer.events, "confirm_resolved"), {
        type: "confirm_resolved",
        requestId: request.id,
        approved: true,
      });
      assert.deepStrictEqual(
        yield* orchestrator.respond({ requestId: request.id, approved: true }),
        { accepted: false },
      );
      assert.strictEqual(yield* Ref.get(executed), 1);
    }),
  ),
);

it.effect("streams each startup stage while its lifecycle work is still pending", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const prepare = yield* Deferred.make<void>();
      const briefing = yield* Deferred.make<void>();
      const realtime = yield* Deferred.make<void>();
      yield* Ref.set(harness.prepareWork, Deferred.await(prepare));
      yield* Ref.set(harness.briefingWork, Deferred.await(briefing));
      yield* Ref.set(harness.realtimeWork, Deferred.await(realtime));
      const { events } = yield* startCall;

      assert.deepStrictEqual(yield* Queue.take(events), {
        type: "startup",
        stage: "preparing-session",
      });
      assert.strictEqual((yield* Ref.get(harness.prepared)).length, 0);
      yield* Deferred.succeed(prepare, undefined);
      assert.deepStrictEqual(yield* Queue.take(events), { type: "startup", stage: "briefing" });
      assert.strictEqual(yield* Queue.size(events), 0);
      yield* Deferred.succeed(briefing, undefined);
      assert.deepStrictEqual(yield* Queue.take(events), {
        type: "startup",
        stage: "starting-realtime",
      });
      assert.strictEqual(yield* Queue.size(events), 0);
      yield* Deferred.succeed(realtime, undefined);
      assert.strictEqual((yield* Queue.take(events)).type, "answer");
    }),
  ),
);

it.effect("a failed setup ends after progress without emitting later stages or an answer", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      yield* Ref.set(
        harness.prepareWork,
        Effect.fail(new VoiceSessionError({ message: "Setup failed." })),
      );
      const { events, fiber } = yield* startCall;
      assert.deepStrictEqual(yield* Queue.take(events), {
        type: "startup",
        stage: "preparing-session",
      });
      assert.deepStrictEqual(yield* Queue.take(events), {
        type: "ended",
        reason: "error",
        message: "Setup failed.",
      });
      yield* Fiber.join(fiber);
      assert.strictEqual(yield* Queue.size(events), 0);
    }),
  ),
);

it.effect("unsubscribing during realtime startup releases the prepared thread", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      yield* Ref.set(harness.realtimeWork, Effect.never);
      const { events, fiber } = yield* startCall;
      yield* takeUntilType(events, "startup");
      yield* Queue.take(events);
      assert.deepStrictEqual(yield* Queue.take(events), {
        type: "startup",
        stage: "starting-realtime",
      });
      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(yield* Ref.get(harness.released), yield* Ref.get(harness.prepared));
      assert.deepStrictEqual(yield* Ref.get(harness.stopped), []);
    }),
  ),
);

it("startup schema rejects stages outside the allowlist and strips extra content", () => {
  const startup = { type: "startup", stage: "briefing" } satisfies VoiceSessionEvent;
  const decode = Schema.decodeUnknownSync(VoiceSessionEvent);
  assert.deepStrictEqual(
    decode({ ...startup, prompt: "private", sdp: "private", log: "private" }),
    startup,
  );
  assert.throws(() => decode({ type: "startup", stage: "provider raw log" }));
});

const approveAfterQuiet = (input: Parameters<VoiceOrchestrator["Service"]["approveSpoken"]>[0]) =>
  Effect.gen(function* () {
    const orchestrator = yield* VoiceOrchestrator;
    const approving = yield* orchestrator.approveSpoken(input).pipe(Effect.forkScoped);
    yield* TestClock.adjust("2 seconds");
    return yield* Fiber.join(approving);
  });

it.effect(
  "spoken approval shares tap execution, rejects objections and never auto executes transcript parts",
  () =>
    withOrchestrator(() =>
      Effect.gen(function* () {
        const orchestrator = yield* VoiceOrchestrator;
        const store = yield* VoiceStore;
        const { answer, events } = yield* openCall;
        const executed = yield* Ref.make(0);
        const proposed = yield* orchestrator.proposeAction({
          action: "launch",
          title: "Start Audit in Work?",
          detail: "Review the change",
          execute: Ref.update(executed, (n) => n + 1).pipe(Effect.as("Started Audit.")),
        });
        assert.isTrue(proposed._tag === "Some");
        const { request } = yield* takeUntilType(events, "confirm");
        const speak = (role: "assistant" | "user", text: string) =>
          DateTime.now.pipe(
            Effect.flatMap((at) =>
              store.appendTranscript({ generation: answer.generation, role, text, at }),
            ),
          );
        yield* TestClock.adjust(Duration.millis(1));
        yield* speak("assistant", confirmationReadback(request));
        yield* speak("user", "Yes");
        assert.strictEqual(yield* Ref.get(executed), 0);
        yield* speak("user", "But no, wait");
        assert.strictEqual(
          (yield* approveAfterQuiet({
            sessionThreadId: answer.sessionThreadId,
            requestId: request.id,
          })).status,
          "needs_spoken_yes",
        );
        assert.strictEqual(yield* Ref.get(executed), 0);
        yield* TestClock.adjust(Duration.millis(1));
        yield* speak("assistant", confirmationReadback(request));
        yield* speak("user", "Yes");
        assert.strictEqual(
          (yield* approveAfterQuiet({
            sessionThreadId: answer.sessionThreadId,
            requestId: request.id,
          })).status,
          "approved",
        );
        assert.strictEqual(yield* Ref.get(executed), 1);
        assert.deepStrictEqual(
          yield* orchestrator.respond({ requestId: request.id, approved: true }),
          { accepted: false },
        );
        assert.isFalse(
          yield* orchestrator.claimSpokenSend({
            sessionThreadId: answer.sessionThreadId,
            text: "Review the change",
            targetTitle: "Work",
          }),
        );
        assert.strictEqual(yield* Ref.get(executed), 1);
      }),
    ),
);

it.effect("pending action IDs, generations, ambiguity and expiry bound spoken approval", () =>
  withOrchestrator(() =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      const store = yield* VoiceStore;
      const first = yield* openCall;
      const executed = yield* Ref.make(0);
      const propose = () =>
        orchestrator.proposeAction({
          action: "launch",
          title: "Audit",
          detail: "Review",
          execute: Ref.update(executed, (n) => n + 1).pipe(Effect.as("Done")),
        });
      yield* propose();
      const request = (yield* takeUntilType(first.events, "confirm")).request;
      const speak = (role: "assistant" | "user", text: string) =>
        DateTime.now.pipe(
          Effect.flatMap((at) =>
            store.appendTranscript({ generation: first.answer.generation, role, text, at }),
          ),
        );
      yield* TestClock.adjust(Duration.millis(1));
      yield* speak("assistant", confirmationReadback(request));
      yield* speak("user", "Yes");
      assert.strictEqual(
        (yield* approveAfterQuiet({
          sessionThreadId: first.answer.sessionThreadId,
          requestId: "wrong-id",
        })).status,
        "unavailable",
      );
      yield* propose();
      const duplicate = (yield* takeUntilType(first.events, "confirm")).request;
      assert.strictEqual(
        (yield* approveAfterQuiet({
          sessionThreadId: first.answer.sessionThreadId,
          requestId: request.id,
        })).status,
        "needs_spoken_yes",
      );
      yield* orchestrator.respond({ requestId: duplicate.id, approved: false });
      yield* TestClock.adjust("2 minutes");
      assert.strictEqual(
        (yield* approveAfterQuiet({
          sessionThreadId: first.answer.sessionThreadId,
          requestId: request.id,
        })).status,
        "unavailable",
      );
      yield* propose();
      const beforeRotation = (yield* takeUntilType(first.events, "confirm")).request;
      const second = yield* openCall;
      assert.deepStrictEqual(
        yield* orchestrator.pendingConfirmations(second.answer.sessionThreadId),
        [],
      );
      assert.strictEqual(
        (yield* approveAfterQuiet({
          sessionThreadId: second.answer.sessionThreadId,
          requestId: beforeRotation.id,
        })).status,
        "unavailable",
      );
      assert.deepStrictEqual(
        yield* orchestrator.respond({ requestId: beforeRotation.id, approved: true }),
        { accepted: false },
      );
      assert.strictEqual(yield* Ref.get(executed), 0);
    }),
  ),
);

it.effect("runtime spoken approval dispatches the original request", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      const { answer, events } = yield* openCall;
      yield* Queue.offer(harness.domainEvents, pendingApproval);
      const { request } = yield* takeUntilType(events, "confirm");
      yield* TestClock.adjust(Duration.millis(1));
      const now = yield* DateTime.now;
      yield* store.appendTranscript({
        generation: answer.generation,
        role: "assistant",
        text: confirmationReadback(request),
        at: now,
      });
      yield* store.appendTranscript({
        generation: answer.generation,
        role: "user",
        text: "Yes",
        at: now,
      });
      const result = yield* approveAfterQuiet({
        sessionThreadId: answer.sessionThreadId,
        requestId: request.id,
      });
      assert.strictEqual(result.status, "approved");
      const responses = (yield* Ref.get(harness.dispatched)).filter(
        (command) => command.type === "runtime-request.respond",
      );
      assert.strictEqual(responses.length, 1);
      assert.deepInclude(responses[0], {
        requestId: approvalRequestId,
        threadId: workThreadId,
        decision: "accept",
      });
    }),
  ),
);

it.effect("an older client gets the answer first without startup progress opt-in", () =>
  withOrchestrator(() =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      const first = yield* orchestrator
        .open({ sdpOffer: "v=0 offer" })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.strictEqual(first[0]?.type, "answer");
    }),
  ),
);

it.effect("a runtime approval that resolved elsewhere cannot be approved by voice or tap", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      const store = yield* VoiceStore;
      const { answer, events } = yield* openCall;
      yield* Queue.offer(harness.domainEvents, pendingApproval);
      const { request } = yield* takeUntilType(events, "confirm");
      yield* Ref.set(harness.requests, []);
      yield* TestClock.adjust(Duration.millis(1));
      const now = yield* DateTime.now;
      yield* store.appendTranscript({
        generation: answer.generation,
        role: "assistant",
        text: confirmationReadback(request),
        at: now,
      });
      yield* store.appendTranscript({
        generation: answer.generation,
        role: "user",
        text: "Yes",
        at: now,
      });
      assert.strictEqual(
        (yield* approveAfterQuiet({
          sessionThreadId: answer.sessionThreadId,
          requestId: request.id,
        })).status,
        "failed",
      );
      assert.deepStrictEqual(
        yield* orchestrator.respond({ requestId: request.id, approved: true }),
        { accepted: false },
      );
      const responses = (yield* Ref.get(harness.dispatched)).filter(
        (command) => command.type === "runtime-request.respond",
      );
      assert.deepStrictEqual(responses, []);
    }),
  ),
);

it.effect(
  "spoken actions and sends wait for quiet, reread split replies and fail closed during activity",
  () =>
    withOrchestrator((harness) =>
      Effect.gen(function* () {
        const orchestrator = yield* VoiceOrchestrator;
        const { answer, events } = yield* openCall;
        const executed = yield* Ref.make(0);
        yield* orchestrator.proposeAction({
          action: "launch",
          title: "Start Audit in Work?",
          detail: "Review the change",
          execute: Ref.update(executed, (n) => n + 1).pipe(Effect.as("Started Audit.")),
        });
        const { request } = yield* takeUntilType(events, "confirm");
        const speak = (role: "assistant" | "user", text: string) =>
          Ref.get(harness.transcriptWork).pipe(
            Effect.flatMap((callback) => callback({ role, text })),
          );
        yield* TestClock.adjust(Duration.millis(1));
        yield* speak("assistant", confirmationReadback(request));
        yield* speak("user", "Yes");
        const approving = yield* orchestrator
          .approveSpoken({ sessionThreadId: answer.sessionThreadId, requestId: request.id })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* Ref.get(executed), 0);
        yield* speak("user", "But no, wait");
        yield* TestClock.adjust("1 second");
        assert.strictEqual((yield* Fiber.join(approving)).status, "needs_spoken_yes");
        assert.strictEqual(yield* Ref.get(executed), 0);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(
          (yield* orchestrator.approveSpoken({
            sessionThreadId: answer.sessionThreadId,
            requestId: request.id,
          })).status,
          "needs_spoken_yes",
        );

        yield* speak("assistant", "I'll send to Work: Review the change. Should I send it?");
        yield* speak("user", "Yes");
        const sending = yield* orchestrator
          .claimSpokenSend({
            sessionThreadId: answer.sessionThreadId,
            text: "Review the change",
            targetTitle: "Work",
          })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        yield* speak("user", "But no");
        yield* TestClock.adjust("1 second");
        assert.isFalse(yield* Fiber.join(sending));
        yield* TestClock.adjust("1 second");
        assert.isFalse(
          yield* orchestrator.claimSpokenSend({
            sessionThreadId: answer.sessionThreadId,
            text: "Review the change",
            targetTitle: "Work",
          }),
        );

        yield* TestClock.adjust(Duration.millis(1));
        yield* speak("assistant", confirmationReadback(request));
        yield* speak("user", "Yes");
        const active = yield* orchestrator
          .approveSpoken({ sessionThreadId: answer.sessionThreadId, requestId: request.id })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        yield* Ref.get(harness.activityWork).pipe(Effect.flatten);
        yield* TestClock.adjust("1 second");
        assert.strictEqual((yield* Fiber.join(active)).status, "needs_spoken_yes");
        assert.strictEqual(yield* Ref.get(executed), 0);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(
          (yield* orchestrator.approveSpoken({
            sessionThreadId: answer.sessionThreadId,
            requestId: request.id,
          })).status,
          "approved",
        );
        assert.strictEqual(yield* Ref.get(executed), 1);
      }),
    ),
);

it.effect("a stale originating session cannot propose an action in a new generation", () =>
  withOrchestrator(() =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      const first = yield* openCall;
      const second = yield* openCall;
      const executed = yield* Ref.make(0);
      const result = yield* orchestrator.proposeAction({
        sessionThreadId: first.answer.sessionThreadId,
        action: "launch",
        title: "Audit",
        detail: "Review the change",
        execute: Ref.update(executed, (n) => n + 1).pipe(Effect.as("Started Audit.")),
      });
      assert.strictEqual(result._tag, "None");
      assert.deepStrictEqual(
        yield* orchestrator.pendingConfirmations(second.answer.sessionThreadId),
        [],
      );
      assert.strictEqual(yield* Queue.size(second.events), 0);
      assert.strictEqual(yield* Ref.get(executed), 0);
    }),
  ),
);

for (const changedField of ["provider", "prompt"] as const) {
  it.effect(`a runtime approval refuses a changed ${changedField} after showing the card`, () =>
    withOrchestrator((harness) =>
      Effect.gen(function* () {
        const orchestrator = yield* VoiceOrchestrator;
        const { events } = yield* openCall;
        yield* Queue.offer(harness.domainEvents, pendingApproval);
        const { request } = yield* takeUntilType(events, "confirm");
        assert.strictEqual(request.detail, "rm -rf build/");

        if (changedField === "provider") {
          yield* Ref.set(harness.requests, [
            {
              ...pendingApproval.payload,
              responseCapability: {
                type: "live",
                providerSessionId: ProviderSessionId.make("replacement-session"),
              },
            },
          ]);
        } else {
          yield* Ref.set(harness.approvalPrompt, "rm -rf another-directory/");
        }

        yield* orchestrator.respond({ requestId: request.id, approved: true });
        assert.deepStrictEqual(yield* takeUntilType(events, "confirm_resolved"), {
          type: "confirm_resolved",
          requestId: request.id,
          approved: false,
        });
        assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
      }),
    ),
  );
}
