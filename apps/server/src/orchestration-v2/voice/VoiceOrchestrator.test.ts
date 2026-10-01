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
  VoiceSessionEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
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
  const prepareWork = yield* Ref.make<Effect.Effect<void, VoiceSessionError>>(Effect.void);
  const briefingWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const realtimeWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const transcriptWork = yield* Ref.make<
    NonNullable<Parameters<PreparedSessionThread["startRealtimeCall"]>[0]["onTranscript"]>
  >(() => Effect.void);
  const activityWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const stopped = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const prepared = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const released = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const speech = yield* Ref.make<ReadonlyArray<string>>([]);
  const runtimeRequests = yield* Ref.make<ReadonlyArray<OrchestrationV2RuntimeRequest>>([
    pendingApproval.payload as OrchestrationV2RuntimeRequest,
  ]);
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);

  const fakeCall = (sessionThreadId: ThreadId): ProviderAdapterV2RealtimeCall => ({
    sdpAnswer: `answer:${sessionThreadId}`,
    ended: Effect.never,
    stop: Ref.update(stopped, (current) => [...current, sessionThreadId]),
    appendText: () => Effect.void,
    appendSpeech: (text) => Ref.update(speech, (current) => [...current, text]),
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
                  Ref.set(transcriptWork, input.onTranscript ?? (() => Effect.void)).pipe(
                    Effect.andThen(Ref.set(activityWork, input.onActivity ?? Effect.void)),
                    Effect.andThen(Ref.get(realtimeWork)),
                    Effect.flatten,
                    Effect.as(fakeCall(sessionThreadId)),
                  ),
              },
              [...current, sessionThreadId],
            ];
          }),
        ),
      ),
    release: (sessionThreadId) => Ref.update(released, (current) => [...current, sessionThreadId]),
  });

  const threadManagement = Layer.mock(ThreadManagementService)({
    streamDomainEvents: Stream.fromQueue(domainEvents),
    getThreadShell: (threadId) => Effect.succeed(threadId === workThreadId ? workShell : null),
    getThreadRecords: () =>
      Ref.get(runtimeRequests).pipe(
        Effect.map(
          (requests) =>
            ({
              runtimeRequests: requests,
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
      Ref.get(briefingWork).pipe(
        Effect.flatten,
        Effect.as({ schemaVersion: 1, snapshotSequence: 0, threads: [], archivedThreads: [] }),
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
  return {
    layer,
    domainEvents,
    prepared,
    released,
    speech,
    dispatched,
    runtimeRequests,
    transcriptWork,
    activityWork,
    prepareWork,
    briefingWork,
    realtimeWork,
    stopped,
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
  const fiber = yield* orchestrator.open({ sdpOffer: "v=0 offer", startupProgress: true }).pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  return { events, fiber };
});

/** Opens a generation, retaining startup events for ordering assertions. */
const openCall = Effect.gen(function* () {
  const { events, fiber } = yield* startCall;
  const startup: VoiceSessionEvent[] = [];
  let answer = yield* Queue.take(events);
  while (answer.type === "startup") {
    startup.push(answer);
    answer = yield* Queue.take(events);
  }
  assert.strictEqual(answer.type, "answer");
  return {
    events,
    fiber,
    startup,
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
      yield* Ref.set(harness.runtimeRequests, []);
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
