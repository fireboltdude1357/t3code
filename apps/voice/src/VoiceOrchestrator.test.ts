import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  VoiceSessionEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as DatabaseMemory } from "./Database.ts";
import { T3Client, type T3ThreadChange } from "./T3Client.ts";
import { confirmationReadback, sendReadback } from "./VoiceConfirmation.ts";
import {
  layer as orchestratorLayer,
  ROTATE_AFTER,
  VoiceOrchestrator,
} from "./VoiceOrchestrator.ts";
import {
  type PreparedSessionThread,
  type RealtimeCall,
  type RealtimeCallEnd,
  type StartRealtimeCallInput,
  VoiceSessionError,
  VoiceSessionService,
} from "./VoiceSessionService.ts";
import { layer as voiceStoreLayer, VoiceStore } from "./VoiceStore.ts";

const workThreadId = ThreadId.make("thread-work");
const workProjectId = ProjectId.make("project-work");
const shellTime = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");

// Only the fields the orchestrator reads.
const workShell = {
  id: workThreadId,
  projectId: workProjectId,
  title: "Fix login",
  archivedAt: null,
  status: "running",
  latestRunId: RunId.make("run-0"),
  pendingRuntimeRequest: null,
  updatedAt: shellTime,
  lineage: { relationshipToParent: null },
} as unknown as OrchestrationV2ThreadShell;

const workProject = {
  id: workProjectId,
  title: "Work",
} as unknown as OrchestrationProjectShell;

const runtimeRequest = (
  id: string,
  kind: OrchestrationV2RuntimeRequest["kind"] = "command",
  providerSessionId = "provider-session",
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(id),
  nodeId: NodeId.make("node"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind,
  status: "pending",
  responseCapability: {
    type: "live",
    providerSessionId: ProviderSessionId.make(providerSessionId),
  },
  createdAt: shellTime,
  resolvedAt: null,
});

const approval = runtimeRequest("request-1");
const question = (id: string) => runtimeRequest(id, "user_input");

const summaryOf = (request: OrchestrationV2RuntimeRequest) => ({
  id: request.id,
  kind: request.kind,
  createdAt: request.createdAt,
});

/**
 * Builds the orchestrator on the real store, with an in-memory T3 server and
 * session service. T3's shell lives in Refs; tests publish shell diffs the way
 * `T3Client` would. Returns the recorders and controls the tests use.
 */
const makeHarness = Effect.gen(function* () {
  const shells = yield* Ref.make<ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>>(
    new Map([[workThreadId, workShell]]),
  );
  const requests = yield* Ref.make<ReadonlyArray<OrchestrationV2RuntimeRequest>>([]);
  const approvalPrompt = yield* Ref.make("rm -rf build/");
  const changes = yield* PubSub.unbounded<T3ThreadChange>();
  const resyncs = yield* PubSub.unbounded<void>();
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
  const commandDispatched = yield* Queue.unbounded<OrchestrationV2Command>();

  const prepareWork = yield* Ref.make<Effect.Effect<void, VoiceSessionError>>(Effect.void);
  const briefingWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const realtimeWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const lastStart = yield* Ref.make<StartRealtimeCallInput | undefined>(undefined);
  const callEnds = yield* Ref.make<ReadonlyMap<ThreadId, Deferred.Deferred<RealtimeCallEnd>>>(
    new Map(),
  );
  const prepared = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const released = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const stopped = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
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

  const t3 = Layer.mock(T3Client)({
    environmentId: "environment-test",
    shell: Ref.get(briefingWork).pipe(
      Effect.flatten,
      Effect.andThen(Ref.get(shells)),
      Effect.map((current) => ({ projects: [workProject], threads: [...current.values()] })),
    ),
    threadShell: (threadId) =>
      Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
    threadChanges: Stream.fromPubSub(changes),
    resynced: Stream.fromPubSub(resyncs),
    threadProjection: () =>
      Effect.all([Ref.get(requests), Ref.get(approvalPrompt)]).pipe(
        Effect.map(
          ([runtimeRequests, prompt]) =>
            ({
              runtimeRequests,
              turnItems: runtimeRequests.map((request) => ({
                type: "approval_request",
                requestId: request.id,
                prompt,
              })),
            }) as unknown as OrchestrationV2ThreadProjection,
        ),
      ),
    dispatch: (command) =>
      Ref.update(dispatched, (current) => [...current, command]).pipe(
        Effect.andThen(Queue.offer(commandDispatched, command)),
        Effect.asVoid,
      ),
  });

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
  ).pipe(Layer.provide(voiceStoreLayer), Layer.provide(DatabaseMemory));

  const fakeCall = (sessionThreadId: ThreadId, ended: Deferred.Deferred<RealtimeCallEnd>) =>
    ({
      sdpAnswer: `answer:${sessionThreadId}`,
      ended: Deferred.await(ended),
      stop: Ref.update(stopped, (current) => [...current, sessionThreadId]),
      appendText: () => Effect.void,
      appendSpeech: (text) =>
        Effect.gen(function* () {
          yield* Queue.offer(speechStarted, text);
          if (yield* Ref.get(holdSpeech)) yield* Deferred.await(releaseSpeech);
          yield* Ref.update(speech, (current) => [...current, text]);
          yield* Queue.offer(speechDone, text);
        }),
    }) satisfies RealtimeCall;

  const prepareSession = (sessionThreadId: ThreadId): PreparedSessionThread => ({
    sessionThreadId,
    startRealtimeCall: (input) =>
      Effect.gen(function* () {
        yield* Ref.set(lastStart, input);
        if (yield* Ref.getAndSet(holdCall, false)) {
          yield* Queue.offer(callStarted, sessionThreadId);
          yield* Deferred.await(releaseCall);
        }
        yield* Ref.get(realtimeWork).pipe(Effect.flatten);
        const ended = yield* Deferred.make<RealtimeCallEnd>();
        yield* Ref.update(callEnds, (current) => new Map(current).set(sessionThreadId, ended));
        return fakeCall(sessionThreadId, ended);
      }),
  });

  const sessionService = Layer.mock(VoiceSessionService)({
    prepare: () =>
      Ref.get(prepareWork).pipe(
        Effect.flatten,
        Effect.andThen(
          Ref.modify(prepared, (current): [PreparedSessionThread, ReadonlyArray<ThreadId>] => {
            const sessionThreadId = ThreadId.make(`session-${current.length + 1}`);
            return [prepareSession(sessionThreadId), [...current, sessionThreadId]];
          }),
        ),
      ),
    release: (sessionThreadId) => Ref.update(released, (current) => [...current, sessionThreadId]),
  });

  const layer = orchestratorLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(store, sessionService, t3)),
    Layer.provideMerge(NodeCrypto.layer),
  );

  /** Publishes a raw shell diff without touching the stored shell. */
  const publish = (change: T3ThreadChange) => PubSub.publish(changes, change).pipe(Effect.asVoid);

  /** Applies `patch` to a thread's shell and publishes the diff, as `T3Client` does. */
  const updateThread = (
    patch: Partial<OrchestrationV2ThreadShell>,
    threadId: ThreadId = workThreadId,
  ) =>
    Ref.modify(shells, (current) => {
      const previous = current.get(threadId);
      const thread = { ...(previous ?? workShell), ...patch, id: threadId };
      return [{ previous, thread }, new Map(current).set(threadId, thread)];
    }).pipe(Effect.flatMap(publish));

  const upsertRequest = (request: OrchestrationV2RuntimeRequest) =>
    Ref.update(requests, (current) => [
      ...current.filter((candidate) => candidate.id !== request.id),
      request,
    ]);

  /** A request T3 shows while the sidecar is not watching: projection and shell, no diff. */
  const seedRequest = (request: OrchestrationV2RuntimeRequest) =>
    upsertRequest(request).pipe(
      Effect.andThen(
        Ref.update(shells, (current) =>
          new Map(current).set(workThreadId, {
            ...(current.get(workThreadId) ?? workShell),
            pendingRuntimeRequest: summaryOf(request),
          }),
        ),
      ),
    );

  const raiseRequest = (request: OrchestrationV2RuntimeRequest) =>
    upsertRequest(request).pipe(
      Effect.andThen(updateThread({ pendingRuntimeRequest: summaryOf(request) })),
    );

  const settleRequest = (request: OrchestrationV2RuntimeRequest) =>
    upsertRequest({ ...request, status: "resolved" }).pipe(
      Effect.andThen(updateThread({ pendingRuntimeRequest: null })),
    );

  /** Speaks a final transcript part into the live call, as Codex would. */
  const speak = (role: "user" | "assistant", text: string) =>
    Ref.get(lastStart).pipe(
      Effect.flatMap((input) => input?.onTranscript?.({ role, text }) ?? Effect.void),
    );

  const endCall = (sessionThreadId: ThreadId, end: RealtimeCallEnd) =>
    Ref.get(callEnds).pipe(
      Effect.flatMap((current) => {
        const ended = current.get(sessionThreadId);
        return ended === undefined ? Effect.die("no call") : Deferred.succeed(ended, end);
      }),
    );

  return {
    layer,
    shells,
    requests,
    approvalPrompt,
    dispatched,
    commandDispatched,
    publish,
    updateThread,
    seedRequest,
    raiseRequest,
    settleRequest,
    resync: PubSub.publish(resyncs, undefined),
    speak,
    endCall,
    lastStart,
    prepareWork,
    briefingWork,
    realtimeWork,
    prepared,
    released,
    stopped,
    speech,
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

/** Lets forked fibers and real I/O (SQLite) catch up. */
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

/** Everything queued once in-flight work settles. */
const drain = (events: Queue.Queue<VoiceSessionEvent>) =>
  settle.pipe(Effect.andThen(Queue.clear(events)));

it.effect("announces a finished run once, in a pause, and marks it delivered", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      const { events } = yield* openCall;

      yield* harness.updateThread({ status: "completed", latestRunId: RunId.make("run-1") });
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

      // A later shell update for the same finished run is not a new finish.
      yield* harness.updateThread({ title: "Fix login" });
      // A replayed transition for the same run is deduped by the ledger.
      const finished = (yield* Ref.get(harness.shells)).get(workThreadId)!;
      yield* harness.publish({ previous: { ...finished, status: "running" }, thread: finished });
      yield* settle;
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      assert.strictEqual((yield* Ref.get(harness.speech)).length, 1);
      assert.strictEqual(yield* Queue.size(events), 0);
      assert.strictEqual((yield* store.recentNotices(10)).length, 1);
    }),
  ),
);

it.effect("a thread seen for the first time and subagent threads announce nothing", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      const { events } = yield* openCall;
      yield* Ref.set(harness.requests, [approval]);
      const busy = {
        ...workShell,
        status: "completed",
        latestRunId: RunId.make("run-1"),
        pendingRuntimeRequest: summaryOf(approval),
      } satisfies OrchestrationV2ThreadShell;
      yield* harness.publish({ previous: undefined, thread: busy });
      const subagent = {
        ...workShell,
        id: ThreadId.make("thread-subagent"),
        lineage: { ...workShell.lineage, relationshipToParent: "subagent" },
      } satisfies OrchestrationV2ThreadShell;
      yield* harness.publish({
        previous: subagent,
        thread: { ...subagent, ...busy, id: subagent.id, lineage: subagent.lineage },
      });
      yield* settle;
      yield* TestClock.adjust("30 seconds");

      assert.deepStrictEqual(yield* drain(events), []);
      assert.deepStrictEqual(yield* Ref.get(harness.speech), []);
      assert.deepStrictEqual(yield* store.recentNotices(10), []);
      assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
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

it.effect("a realtime call that fails ends the generation and releases its thread", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      const { answer, events, fiber } = yield* openCall;
      yield* harness.endCall(answer.sessionThreadId, {
        type: "error",
        message: "Codex dropped the call.",
      });
      assert.deepStrictEqual(yield* takeUntilType(events, "ended"), {
        type: "ended",
        reason: "error",
        message: "Codex dropped the call.",
      });
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(yield* Ref.get(harness.released), [answer.sessionThreadId]);
      assert.deepStrictEqual(yield* Ref.get(harness.stopped), [answer.sessionThreadId]);
      assert.strictEqual((yield* orchestrator.liveSession(answer.sessionThreadId))._tag, "None");
    }),
  ),
);

it.effect("briefs the call on recent threads, news, agenda and the focus thread", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      const now = yield* DateTime.now;
      yield* Ref.update(harness.shells, (current) =>
        new Map(current).set(ThreadId.make("thread-subagent"), {
          ...workShell,
          id: ThreadId.make("thread-subagent"),
          title: "Hidden helper",
          lineage: { ...workShell.lineage, relationshipToParent: "subagent" },
        }),
      );
      yield* store.recordNotice({
        id: "notice-earlier",
        dedupeKey: "earlier",
        kind: "failed",
        threadId: workThreadId,
        threadTitle: "Fix login",
        text: "Fix login failed.",
        createdAt: now,
      });
      const topic = yield* store.openTopic({ title: "Ask about the deploy", detail: "" });

      const orchestrator = yield* VoiceOrchestrator;
      const events = yield* Queue.unbounded<VoiceSessionEvent>();
      yield* orchestrator.open({ sdpOffer: "v=0 offer", focusThreadId: workThreadId }).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      assert.strictEqual((yield* Queue.take(events)).type, "answer");

      const start = yield* Ref.get(harness.lastStart);
      const briefing = start?.initialItems?.[0];
      assert.strictEqual(briefing?.role, "developer");
      assert.include(briefing?.text, `- Fix login (Work, ${workThreadId}): running`);
      assert.include(briefing?.text, "Not yet told to the user:\n- Fix login failed.");
      assert.include(briefing?.text, `- Ask about the deploy [topic, ${topic.id}]`);
      assert.include(briefing?.text, `The user opened the call from "Fix login"`);
      assert.notInclude(briefing?.text, "Hidden helper");
      assert.include(start?.agentStartInstructions, `"Fix login" (threadId ${workThreadId})`);
      assert.include(start?.agentStartInstructions, topic.id);
      // Briefed news counts as told.
      assert.deepStrictEqual(yield* store.undeliveredNotices(10), []);
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
      assert.deepStrictEqual(yield* takeUntilType(events, "confirm_resolved"), {
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

it.effect("a new pending request shows a card and notice; a phone approval dispatches it", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      const { events } = yield* openCall;
      yield* harness.raiseRequest(approval);
      const notices = yield* takeUntilType(events, "request_notices");
      assert.deepStrictEqual(
        notices.notices.map((notice) => [notice.kind, notice.requestId]),
        [["approval", approval.id]],
      );
      const confirm = yield* takeUntilType(events, "confirm");
      assert.strictEqual(confirm.request.action, "runtime_approval");
      assert.strictEqual(confirm.request.detail, "rm -rf build/");
      assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);

      yield* orchestrator.respond({ requestId: confirm.request.id, approved: true });
      assert.isTrue((yield* takeUntilType(events, "confirm_resolved")).approved);
      assert.deepInclude(yield* Queue.take(harness.commandDispatched), {
        type: "runtime-request.respond",
        threadId: workThreadId,
        requestId: approval.id,
        decision: "accept",
      });
    }),
  ),
);

it.effect(
  "an approval pending before the call gets a gate and dispatches only after approval",
  () =>
    withOrchestrator((harness) =>
      Effect.gen(function* () {
        const orchestrator = yield* VoiceOrchestrator;
        yield* harness.seedRequest(approval);
        const first = yield* openCall;
        assert.strictEqual(first.snapshot.notices[0]?.requestId, approval.id);
        const confirm = yield* takeUntilType(first.events, "confirm");
        assert.strictEqual(confirm.request.detail, "rm -rf build/");
        assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
        yield* orchestrator.respond({ requestId: confirm.request.id, approved: true });
        yield* takeUntilType(first.events, "confirm_resolved");
        assert.deepInclude(yield* Queue.take(harness.commandDispatched), {
          type: "runtime-request.respond",
          requestId: approval.id,
        });
      }),
    ),
);

it.effect(
  "post-live reconciliation and a concurrent shell diff share one approval gate per generation",
  () =>
    withOrchestrator((harness) =>
      Effect.gen(function* () {
        yield* harness.seedRequest(approval);
        yield* Ref.set(harness.holdRequestQuery, true);
        const opening = yield* openCall.pipe(Effect.forkScoped);
        yield* Queue.take(harness.requestQueryStarted);
        const current = (yield* Ref.get(harness.shells)).get(workThreadId)!;
        yield* harness.publish({
          previous: { ...current, pendingRuntimeRequest: null },
          thread: current,
        });
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
        if (confirm?.type !== "confirm") return assert.fail("no approval card");

        const second = yield* openCall;
        const carried = yield* Queue.take(second.events);
        if (carried.type !== "confirm") return assert.fail("no carried approval card");
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

for (const outcome of ["denied", "expired"] as const) {
  it.effect(`a ${outcome} approval is not prompted again until the next generation`, () =>
    withOrchestrator((harness) =>
      Effect.gen(function* () {
        const orchestrator = yield* VoiceOrchestrator;
        yield* harness.seedRequest(approval);
        const first = yield* openCall;
        const confirm = yield* takeUntilType(first.events, "confirm");
        if (outcome === "denied") {
          yield* orchestrator.respond({ requestId: confirm.request.id, approved: false });
        } else {
          yield* TestClock.adjust("2 minutes");
        }
        assert.isFalse((yield* takeUntilType(first.events, "confirm_resolved")).approved);

        // A T3 reconnect reconciles the still-pending request without a new card.
        yield* harness.resync;
        assert.notInclude(
          (yield* drain(first.events)).map((event) => event.type),
          "confirm",
        );

        const second = yield* openCall;
        const retried = yield* Queue.take(second.events);
        if (retried.type !== "confirm") return assert.fail("no fresh approval card");
        assert.notStrictEqual(retried.request.id, confirm.request.id);
        assert.deepStrictEqual(yield* Queue.takeAll(first.events), [
          { type: "ended", reason: "rotated" },
        ]);
        assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
      }),
    ),
  );
}

it.effect("settlement during setup prevents an approval prompt", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      yield* harness.seedRequest(approval);
      yield* Ref.set(harness.holdCall, true);
      const opening = yield* openCall.pipe(Effect.forkScoped);
      yield* Queue.take(harness.callStarted);
      // The shell still trails; only the projection knows it was answered.
      yield* Ref.set(harness.requests, [{ ...approval, status: "resolved" }]);
      yield* Deferred.succeed(harness.releaseCall, undefined);
      const first = yield* Fiber.join(opening);
      assert.deepStrictEqual(first.snapshot.notices, []);
      assert.notInclude(
        (yield* drain(first.events)).map((event) => event.type),
        "confirm",
      );
      assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
    }),
  ),
);

it.effect("a request leaving the shell closes its gate; a stale diff cannot restore it", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      const { events } = yield* openCall;
      yield* harness.raiseRequest(approval);
      const confirm = yield* takeUntilType(events, "confirm");
      const pending = yield* harness.shells.pipe(
        Ref.get,
        Effect.map((current) => current.get(workThreadId)!),
      );

      yield* harness.settleRequest(approval);
      const cleared: VoiceSessionEvent[] = [];
      while (
        !cleared.some((event) => event.type === "request_notices") ||
        !cleared.some((event) => event.type === "confirm_resolved")
      ) {
        cleared.push(yield* Queue.take(events));
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

      // A diff that trails the projection names the answered request again.
      yield* harness.publish({
        previous: { ...pending, pendingRuntimeRequest: null },
        thread: pending,
      });
      yield* harness.raiseRequest(question("receipt-question"));
      assert.deepStrictEqual(
        (yield* takeUntilType(events, "request_notices")).notices.map((notice) => notice.requestId),
        [RuntimeRequestId.make("receipt-question")],
      );
      assert.notInclude(
        (yield* drain(events)).map((event) => event.type),
        "confirm",
      );
      assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
    }),
  ),
);

it.effect("clears an answered question at once and shows a later question on the same thread", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      const { events } = yield* openCall;
      yield* harness.raiseRequest(question("question-1"));
      const pending = yield* takeUntilType(events, "request_notices");
      assert.deepStrictEqual(
        pending.notices.map((notice) => [notice.kind, notice.requestId]),
        [["input", RuntimeRequestId.make("question-1")]],
      );
      assert.deepStrictEqual(yield* Ref.get(harness.speech), []);

      yield* harness.settleRequest(question("question-1"));
      assert.deepStrictEqual((yield* takeUntilType(events, "request_notices")).notices, []);
      assert.deepStrictEqual(yield* store.undeliveredNotices(10), []);

      yield* harness.raiseRequest(question("question-2"));
      assert.deepStrictEqual(
        (yield* takeUntilType(events, "request_notices")).notices.map((notice) => notice.requestId),
        [RuntimeRequestId.make("question-2")],
      );
    }),
  ),
);

it.effect("a T3 resync reconciles requests that came and went while disconnected", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      const { events } = yield* openCall;
      const offline = question("question-offline");
      yield* harness.raiseRequest(offline);
      yield* takeUntilType(events, "request_notices");

      // While disconnected, the question was answered and an approval appeared.
      const missed = runtimeRequest("approval-offline");
      yield* Ref.set(harness.requests, [{ ...offline, status: "resolved" }]);
      yield* harness.seedRequest(missed);
      yield* harness.resync;

      const confirm = yield* takeUntilType(events, "confirm");
      assert.strictEqual(confirm.request.action, "runtime_approval");
      assert.strictEqual(confirm.request.threadId, workThreadId);
      assert.deepStrictEqual(
        (yield* store.pendingRequestNotices(10)).map((notice) => notice.requestId),
        [missed.id],
      );
      assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
    }),
  ),
);

it.effect("reconnect drops an archived thread's question and restores it when unarchived", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      const first = yield* openCall;
      yield* harness.raiseRequest(question("question-archived"));
      const pending = yield* takeUntilType(first.events, "request_notices");
      assert.strictEqual(pending.notices[0]?.requestId, RuntimeRequestId.make("question-archived"));

      const connected = yield* openCall;
      assert.deepStrictEqual(connected.snapshot.notices, pending.notices);
      assert.deepStrictEqual(yield* store.undeliveredNotices(10), []);

      // T3Client drops archived threads from its shell and reports the update.
      const shell = (yield* Ref.get(harness.shells)).get(workThreadId)!;
      yield* Ref.update(harness.shells, (current) => {
        const updated = new Map(current);
        updated.delete(workThreadId);
        return updated;
      });
      yield* harness.publish({
        previous: shell,
        thread: { ...shell, archivedAt: DateTime.makeUnsafe("2026-10-01T00:01:00.000Z") },
      });
      const archived = yield* openCall;
      assert.deepStrictEqual(archived.snapshot.notices, []);
      assert.deepStrictEqual(yield* store.pendingRequestNotices(10), []);

      // Unarchived, it is first sight again.
      yield* Ref.update(harness.shells, (current) => new Map(current).set(workThreadId, shell));
      yield* harness.publish({ previous: undefined, thread: shell });
      const restored = yield* openCall;
      assert.deepStrictEqual(restored.snapshot.notices, pending.notices);
      assert.deepStrictEqual(yield* store.undeliveredNotices(10), []);

      yield* harness.settleRequest(question("question-archived"));
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
      yield* harness.raiseRequest(question("question-generation-race"));
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
      if (next.type !== "confirm") return assert.fail(`expected confirm, got ${next.type}`);
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

/** Finishes seven runs on the work thread, one shell diff each. */
const finishRuns = (harness: Harness, prefix: string) =>
  Effect.forEach(
    Array.from({ length: 7 }, (_, index) => index),
    (index) =>
      harness.updateThread({ status: "completed", latestRunId: RunId.make(`${prefix}-${index}`) }),
    { discard: true },
  );

it.effect("a delayed speech completion cannot restore an answered question card", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      yield* Ref.set(harness.holdSpeech, true);
      const { events } = yield* openCall;
      yield* harness.raiseRequest(question("question-race"));
      yield* takeUntilType(events, "request_notices");
      yield* finishRuns(harness, "race-run");
      yield* TestClock.adjust("10 seconds");
      yield* Queue.take(harness.speechStarted);
      yield* Queue.clear(events);

      yield* harness.settleRequest(question("question-race"));
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

it.effect("keeps the original notice protocol for clients without request snapshots", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      const events = yield* Queue.unbounded<VoiceSessionEvent>();
      yield* orchestrator.open({ sdpOffer: "v=0 legacy offer" }).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      assert.strictEqual((yield* Queue.take(events)).type, "answer");
      yield* harness.raiseRequest(question("legacy-client-question"));
      yield* finishRuns(harness, "legacy-run");
      yield* TestClock.adjust("10 seconds");
      const first = yield* Queue.take(events);
      if (first.type !== "notice") return assert.fail(`expected notice, got ${first.type}`);
      assert.strictEqual(first.notice.kind, "input");
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
        {
          accepted: true,
        },
      );
      assert.deepStrictEqual(yield* takeUntilType(newer.events, "confirm_resolved"), {
        type: "confirm_resolved",
        requestId: request.id,
        approved: true,
      });
      assert.deepStrictEqual(
        yield* orchestrator.respond({ requestId: request.id, approved: true }),
        {
          accepted: false,
        },
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

const approveAfterQuiet = (input: Parameters<VoiceOrchestrator["Service"]["approveSpoken"]>[0]) =>
  Effect.gen(function* () {
    const orchestrator = yield* VoiceOrchestrator;
    const approving = yield* orchestrator.approveSpoken(input).pipe(Effect.forkScoped);
    yield* TestClock.adjust("2 seconds");
    return yield* Fiber.join(approving);
  });

/** Writes a transcript part straight to the store, stamped now. */
const record = (generation: number, role: "assistant" | "user", text: string) =>
  Effect.gen(function* () {
    const store = yield* VoiceStore;
    yield* store.appendTranscript({ generation, role, text, at: yield* DateTime.now });
  });

it.effect(
  "spoken approval shares tap execution, rejects objections and never auto executes transcript parts",
  () =>
    withOrchestrator(() =>
      Effect.gen(function* () {
        const orchestrator = yield* VoiceOrchestrator;
        const { answer, events } = yield* openCall;
        const executed = yield* Ref.make(0);
        const proposed = yield* orchestrator.proposeAction({
          action: "launch",
          title: "Start Audit in Work?",
          detail: "Review the change",
          execute: Ref.update(executed, (n) => n + 1).pipe(Effect.as("Started Audit.")),
        });
        assert.strictEqual(proposed._tag, "Some");
        const { request } = yield* takeUntilType(events, "confirm");
        const session = { sessionThreadId: answer.sessionThreadId, requestId: request.id };
        yield* TestClock.adjust(Duration.millis(1));
        yield* record(answer.generation, "assistant", confirmationReadback(request));
        yield* record(answer.generation, "user", "Yes");
        assert.strictEqual(yield* Ref.get(executed), 0);
        yield* record(answer.generation, "user", "But no, wait");
        assert.strictEqual((yield* approveAfterQuiet(session)).status, "needs_spoken_yes");
        assert.strictEqual(yield* Ref.get(executed), 0);

        yield* TestClock.adjust(Duration.millis(1));
        yield* record(answer.generation, "assistant", confirmationReadback(request));
        yield* record(answer.generation, "user", "Yes");
        assert.strictEqual((yield* approveAfterQuiet(session)).status, "approved");
        assert.strictEqual(yield* Ref.get(executed), 1);
        assert.deepStrictEqual(
          yield* orchestrator.respond({ requestId: request.id, approved: true }),
          {
            accepted: false,
          },
        );
        // The yes was consumed by the approval, so it cannot also send.
        assert.isFalse(
          yield* orchestrator.claimSpokenSend({
            sessionThreadId: answer.sessionThreadId,
            threadId: workThreadId,
            text: "Review the change",
            mode: "auto",
            readback: sendReadback({ title: "Work", draft: "Review the change" }),
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
      const first = yield* openCall;
      const executed = yield* Ref.make(0);
      const propose = orchestrator.proposeAction({
        action: "launch",
        title: "Audit",
        detail: "Review",
        execute: Ref.update(executed, (n) => n + 1).pipe(Effect.as("Done")),
      });
      yield* propose;
      const request = (yield* takeUntilType(first.events, "confirm")).request;
      yield* TestClock.adjust(Duration.millis(1));
      yield* record(first.answer.generation, "assistant", confirmationReadback(request));
      yield* record(first.answer.generation, "user", "Yes");
      assert.strictEqual(
        (yield* approveAfterQuiet({
          sessionThreadId: first.answer.sessionThreadId,
          requestId: "wrong-id",
        })).status,
        "unavailable",
      );
      // Two identical readbacks can't be told apart by one yes.
      yield* propose;
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
      yield* propose;
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
      const { answer, events } = yield* openCall;
      yield* harness.raiseRequest(approval);
      const { request } = yield* takeUntilType(events, "confirm");
      yield* TestClock.adjust(Duration.millis(1));
      yield* record(answer.generation, "assistant", confirmationReadback(request));
      yield* record(answer.generation, "user", "Yes");
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
        requestId: approval.id,
        threadId: workThreadId,
        decision: "accept",
      });
      assert.include(
        (yield* Ref.get(harness.speech)).at(-1),
        "Fix login's runtime request was approved.",
      );
    }),
  ),
);

it.effect("a runtime approval that resolved elsewhere cannot be approved by voice or tap", () =>
  withOrchestrator((harness) =>
    Effect.gen(function* () {
      const orchestrator = yield* VoiceOrchestrator;
      const { answer, events } = yield* openCall;
      yield* harness.raiseRequest(approval);
      const { request } = yield* takeUntilType(events, "confirm");
      yield* Ref.set(harness.requests, []);
      yield* TestClock.adjust(Duration.millis(1));
      yield* record(answer.generation, "assistant", confirmationReadback(request));
      yield* record(answer.generation, "user", "Yes");
      assert.strictEqual(
        (yield* approveAfterQuiet({
          sessionThreadId: answer.sessionThreadId,
          requestId: request.id,
        })).status,
        "failed",
      );
      assert.deepStrictEqual(
        yield* orchestrator.respond({ requestId: request.id, approved: true }),
        {
          accepted: false,
        },
      );
      assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
    }),
  ),
);

for (const changedField of ["provider", "prompt"] as const) {
  it.effect(`a runtime approval refuses a changed ${changedField} after showing the card`, () =>
    withOrchestrator((harness) =>
      Effect.gen(function* () {
        const orchestrator = yield* VoiceOrchestrator;
        const { events } = yield* openCall;
        yield* harness.raiseRequest(approval);
        const { request } = yield* takeUntilType(events, "confirm");
        assert.strictEqual(request.detail, "rm -rf build/");

        if (changedField === "provider") {
          yield* Ref.set(harness.requests, [
            runtimeRequest("request-1", "command", "replacement-session"),
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
        const session = { sessionThreadId: answer.sessionThreadId, requestId: request.id };
        const sendReadbackText = sendReadback({ title: "Work", draft: "Review the change" });
        const sendDraft = {
          sessionThreadId: answer.sessionThreadId,
          threadId: workThreadId,
          text: "Review the change",
          mode: "auto" as const,
          readback: sendReadbackText,
        };

        // An objection inside the quiet window cancels the pending approval.
        yield* TestClock.adjust(Duration.millis(1));
        yield* harness.speak("assistant", confirmationReadback(request));
        yield* harness.speak("user", "Yes");
        const approving = yield* orchestrator.approveSpoken(session).pipe(Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* Ref.get(executed), 0);
        yield* harness.speak("user", "But no, wait");
        yield* TestClock.adjust("1 second");
        assert.strictEqual((yield* Fiber.join(approving)).status, "needs_spoken_yes");
        assert.strictEqual(yield* Ref.get(executed), 0);
        yield* TestClock.adjust("1 second");
        assert.strictEqual((yield* orchestrator.approveSpoken(session)).status, "needs_spoken_yes");

        // The same holds for a send, once voice_send has issued its readback.
        assert.isFalse(yield* orchestrator.claimSpokenSend(sendDraft));
        yield* TestClock.adjust(Duration.millis(1));
        yield* harness.speak("assistant", sendReadbackText);
        yield* harness.speak("user", "Yes");
        const sending = yield* orchestrator.claimSpokenSend(sendDraft).pipe(Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        yield* harness.speak("user", "But no");
        yield* TestClock.adjust("1 second");
        assert.isFalse(yield* Fiber.join(sending));
        yield* TestClock.adjust("1 second");
        assert.isFalse(yield* orchestrator.claimSpokenSend(sendDraft));
        // A fresh exact readback and a plain yes do send, once.
        yield* harness.speak("assistant", sendReadbackText);
        yield* harness.speak("user", "Yes");
        const resent = yield* orchestrator.claimSpokenSend(sendDraft).pipe(Effect.forkScoped);
        yield* TestClock.adjust("2 seconds");
        assert.isTrue(yield* Fiber.join(resent));
        assert.isFalse(yield* orchestrator.claimSpokenSend(sendDraft));

        // Speech still in progress (no final part yet) also fails the attempt.
        yield* TestClock.adjust(Duration.millis(1));
        yield* harness.speak("assistant", confirmationReadback(request));
        yield* harness.speak("user", "Yes");
        const active = yield* orchestrator.approveSpoken(session).pipe(Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        const start = yield* Ref.get(harness.lastStart);
        yield* start?.onActivity?.("user") ?? Effect.void;
        yield* TestClock.adjust("1 second");
        assert.strictEqual((yield* Fiber.join(active)).status, "needs_spoken_yes");
        assert.strictEqual(yield* Ref.get(executed), 0);
        yield* TestClock.adjust("1 second");
        assert.strictEqual((yield* orchestrator.approveSpoken(session)).status, "approved");
        assert.strictEqual(yield* Ref.get(executed), 1);
      }),
    ),
);

it.effect("the voice model's own filler during the quiet window does not void a yes", () =>
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
      yield* TestClock.adjust(Duration.millis(1));
      yield* harness.speak("assistant", confirmationReadback(request));
      yield* harness.speak("user", "Yes, I approve this action");
      const approving = yield* orchestrator
        .approveSpoken({ sessionThreadId: answer.sessionThreadId, requestId: request.id })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("1 second");
      // Seen live: GPT-Live says "one moment, submitting that now" while the agent approves.
      const start = yield* Ref.get(harness.lastStart);
      yield* start?.onActivity?.("assistant") ?? Effect.void;
      yield* TestClock.adjust("1 second");
      assert.strictEqual((yield* Fiber.join(approving)).status, "approved");
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

const claimAfterQuiet = (input: Parameters<VoiceOrchestrator["Service"]["claimSpokenSend"]>[0]) =>
  Effect.gen(function* () {
    const orchestrator = yield* VoiceOrchestrator;
    const claiming = yield* orchestrator.claimSpokenSend(input).pipe(Effect.forkScoped);
    yield* TestClock.adjust("2 seconds");
    return yield* Fiber.join(claiming);
  });

it.effect("a spoken send yes counts only for a send voice_send already issued", () =>
  withOrchestrator(() =>
    Effect.gen(function* () {
      const { answer } = yield* openCall;
      const send = (threadId: ThreadId, title: string, text: string) => ({
        sessionThreadId: answer.sessionThreadId,
        threadId,
        text,
        mode: "auto" as const,
        readback: sendReadback({ title, draft: text }),
      });
      const toWork = send(workThreadId, "Work", "Ship it.");
      const toOther = send(ThreadId.make("thread-other"), "Other", "Ship it.");
      const sayYesTo = (readback: string) =>
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.millis(1));
          yield* record(answer.generation, "assistant", readback);
          yield* record(answer.generation, "user", "Yes");
        });

      // A yes heard before the send was issued never counts, even once issued.
      yield* sayYesTo(toWork.readback);
      assert.isFalse(yield* claimAfterQuiet(toWork));
      assert.isFalse(yield* claimAfterQuiet(toWork));

      // A first call for another thread doesn't spend the yes to this one's readback.
      yield* sayYesTo(toWork.readback);
      assert.isFalse(yield* claimAfterQuiet(toOther));
      assert.isTrue(yield* claimAfterQuiet(toWork));

      // Two issued sends that sound the same can't be told apart by a yes.
      const plain = send(workThreadId, "Work", "Ship it");
      const punctuated = send(workThreadId, "Work", "Ship it!");
      assert.isFalse(yield* claimAfterQuiet(plain));
      assert.isFalse(yield* claimAfterQuiet(punctuated));
      yield* sayYesTo(plain.readback);
      assert.isFalse(yield* claimAfterQuiet(plain));
      assert.isFalse(yield* claimAfterQuiet(punctuated));
    }),
  ),
);
