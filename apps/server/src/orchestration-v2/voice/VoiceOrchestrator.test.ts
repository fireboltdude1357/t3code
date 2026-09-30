import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ServerCommand,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadShell,
  type Project,
  type VoiceSessionEvent,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
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
  const prepared = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const released = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const speech = yield* Ref.make<ReadonlyArray<string>>([]);
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);

  const fakeCall = (sessionThreadId: ThreadId): ProviderAdapterV2RealtimeCall => ({
    sdpAnswer: `answer:${sessionThreadId}`,
    ended: Effect.never,
    stop: Effect.void,
    appendText: () => Effect.void,
    appendSpeech: (text) => Ref.update(speech, (current) => [...current, text]),
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
            startRealtimeCall: () => Effect.succeed(fakeCall(sessionThreadId)),
          },
          [...current, sessionThreadId],
        ];
      }),
    release: (sessionThreadId) => Ref.update(released, (current) => [...current, sessionThreadId]),
  });

  const threadManagement = Layer.mock(ThreadManagementService)({
    streamDomainEvents: Stream.fromQueue(domainEvents),
    getThreadShell: (threadId) => Effect.succeed(threadId === workThreadId ? workShell : null),
    getThreadRecords: () =>
      Effect.succeed({
        turnItems: [
          { type: "approval_request", requestId: approvalRequestId, prompt: "rm -rf build/" },
        ],
      } as never),
    dispatch: (command) =>
      Ref.update(dispatched, (current) => [...current, command]).pipe(
        Effect.as({ sequence: 1, storedEvents: [] } as never),
      ),
    getShellSnapshot: () =>
      Effect.succeed({ schemaVersion: 1, snapshotSequence: 0, threads: [], archivedThreads: [] }),
  });

  const projects = Layer.mock(ProjectService)({
    bootstrap: () =>
      Effect.succeed({ project: { id: voiceProjectId } as unknown as Project, created: true }),
    listShells: () => Effect.succeed([]),
  });

  const layer = orchestratorLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        voiceStoreLayer,
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
  return { layer, domainEvents, prepared, released, speech, dispatched };
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
  const fiber = yield* orchestrator.open({ sdpOffer: "v=0 offer" }).pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const answer = yield* Queue.take(events);
  assert.strictEqual(answer.type, "answer");
  return {
    events,
    fiber,
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
      const responses = (yield* Ref.get(harness.dispatched)).filter(
        (command) => command.type === "runtime-request.respond",
      );
      assert.deepInclude(responses[0], {
        type: "runtime-request.respond",
        threadId: workThreadId,
        requestId: approvalRequestId,
        decision: "accept",
      });
    }),
  ),
);
