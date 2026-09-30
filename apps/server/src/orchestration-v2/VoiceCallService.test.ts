import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2Run,
  type VoiceCallEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2RealtimeCallEnd,
  type ProviderAdapterV2SessionRuntime,
} from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import * as VoiceCall from "./VoiceCallService.ts";
import * as VoiceForkRegistry from "./VoiceForkRegistry.ts";

const sourceThreadId = ThreadId.make("thread_voice_source");
const codex = ProviderDriverKind.make("codex");

interface Harness {
  readonly commands: Array<string>;
  readonly log: Array<string>;
  readonly realtimeEnded: Deferred.Deferred<ProviderAdapterV2RealtimeCallEnd>;
}

/** Fakes the orchestrator and a Codex session so only VoiceCallService runs for real. */
const makeLayer = (options: {
  readonly sourceRunStatus?: OrchestrationV2Run["status"];
  readonly realtimeError?: string;
}) =>
  Effect.gen(function* () {
    const harness: Harness = {
      commands: [],
      log: [],
      realtimeEnded: yield* Deferred.make<ProviderAdapterV2RealtimeCallEnd>(),
    };
    const records = {
      thread: {
        id: sourceThreadId,
        projectId: "project_voice",
        title: "Source",
        activeProviderThreadId: "provider_thread_fork",
      },
      runs: [{ id: "run_source", ordinal: 1, status: options.sourceRunStatus ?? "completed" }],
      providerThreads: [{ id: "provider_thread_fork", providerSessionId: "provider_session" }],
    };
    const runtime = {
      driver: codex,
      startRealtimeCall: (input) =>
        options.realtimeError === undefined
          ? Effect.sync(() => {
              harness.log.push(`start:${input.sdpOffer}`);
              return {
                sdpAnswer: "answer-sdp",
                ended: Deferred.await(harness.realtimeEnded),
                stop: Effect.sync(() => void harness.log.push("stop")),
              };
            })
          : Effect.fail(
              new ProviderAdapterProtocolError({ driver: codex, detail: options.realtimeError }),
            ),
    } as Pick<ProviderAdapterV2SessionRuntime, "driver" | "startRealtimeCall">;
    const layer = VoiceCall.layer.pipe(
      Layer.provide(
        Layer.mock(ThreadManagementService)({
          dispatch: (command) =>
            Effect.sync(() => {
              harness.commands.push(command.type);
              return { sequence: harness.commands.length, storedEvents: [] };
            }),
          getThreadRecords: () =>
            Effect.succeed(
              records as unknown as Effect.Success<
                ReturnType<ThreadManagementService["Service"]["getThreadRecords"]>
              >,
            ),
          sendToThread: (input) =>
            Effect.sync(() => {
              harness.log.push(`instructions:${input.threadId === sourceThreadId}`);
              return { run: { id: "run_fork" } } as unknown as Effect.Success<
                ReturnType<ThreadManagementService["Service"]["sendToThread"]>
              >;
            }),
          waitForThread: (input) =>
            Effect.succeed({
              threadId: input.threadId,
              run: { status: "completed" } as OrchestrationV2Run,
              timedOut: false,
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderSessionManagerV2)({
          get: () => Effect.succeedSome(runtime as ProviderAdapterV2SessionRuntime),
        }),
      ),
      Layer.provide(Layer.merge(NodeServices.layer, VoiceForkRegistry.layer)),
    );
    return { harness, layer };
  });

const input = { sourceThreadId, sdpOffer: "offer-sdp" };

it.effect("answers, ends with sent once the fork sends, then stops realtime and archives", () =>
  Effect.gen(function* () {
    const { harness, layer } = yield* makeLayer({});
    yield* Effect.gen(function* () {
      const service = yield* VoiceCall.VoiceCallService;
      const events: Array<VoiceCallEvent> = [];
      yield* service.start(input).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type !== "answer") return;
            // The fork may send only to its parent while the call is live.
            assert.isTrue(
              yield* service.isVoiceForkSendingToParent(event.forkThreadId, sourceThreadId),
            );
            assert.isFalse(
              yield* service.isVoiceForkSendingToParent(event.forkThreadId, event.forkThreadId),
            );
            yield* service.markSent(event.forkThreadId);
          }),
        ),
      );
      const answer = events[0];
      assert.equal(answer?.type, "answer");
      assert.equal(answer?.type === "answer" ? answer.sdpAnswer : null, "answer-sdp");
      assert.deepEqual(events[1], { type: "ended", reason: "sent" });
      assert.deepEqual(harness.commands, [
        "thread.fork",
        "thread.model-selection.set",
        "thread.runtime-mode.set",
        "thread.archive",
      ]);
      assert.deepEqual(harness.log, ["instructions:false", "start:offer-sdp", "stop"]);
      if (answer?.type === "answer") {
        assert.isFalse(
          yield* service.isVoiceForkSendingToParent(answer.forkThreadId, sourceThreadId),
        );
      }
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("hanging up stops realtime and archives the fork", () =>
  Effect.gen(function* () {
    const { harness, layer } = yield* makeLayer({});
    yield* Effect.gen(function* () {
      const service = yield* VoiceCall.VoiceCallService;
      // Taking only the answer interrupts the stream, as a client unsubscribe does.
      const events = yield* service.start(input).pipe(Stream.take(1), Stream.runCollect);
      assert.equal(events[0]?.type, "answer");
      assert.equal(harness.commands.at(-1), "thread.archive");
      assert.equal(harness.log.at(-1), "stop");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a provider-side close ends the call as closed", () =>
  Effect.gen(function* () {
    const { harness, layer } = yield* makeLayer({});
    yield* Effect.gen(function* () {
      const service = yield* VoiceCall.VoiceCallService;
      yield* Deferred.succeed(harness.realtimeEnded, { type: "closed", reason: null });
      const events = yield* service.start(input).pipe(Stream.runCollect);
      assert.deepEqual(events.at(-1), { type: "ended", reason: "closed" });
      assert.equal(harness.commands.at(-1), "thread.archive");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("reports start failures as an ended error and still archives the fork", () =>
  Effect.gen(function* () {
    const { harness, layer } = yield* makeLayer({ realtimeError: "Realtime unavailable" });
    yield* Effect.gen(function* () {
      const service = yield* VoiceCall.VoiceCallService;
      const events = yield* service.start(input).pipe(Stream.runCollect);
      assert.equal(events.length, 1);
      const ended = events[0];
      assert.equal(ended?.type === "ended" ? ended.reason : null, "error");
      assert.include(ended?.type === "ended" ? ended.message : "", "Realtime unavailable");
      assert.equal(harness.commands.at(-1), "thread.archive");
      assert.notInclude(harness.log, "stop");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses to fork a thread whose turn is still running", () =>
  Effect.gen(function* () {
    const { harness, layer } = yield* makeLayer({ sourceRunStatus: "running" });
    yield* Effect.gen(function* () {
      const service = yield* VoiceCall.VoiceCallService;
      const events = yield* service.start(input).pipe(Stream.runCollect);
      assert.deepEqual(events, [
        {
          type: "ended",
          reason: "error",
          message: "Wait for the current turn to finish before starting a voice call.",
        },
      ]);
      assert.deepEqual(harness.commands, []);
    }).pipe(Effect.provide(layer));
  }),
);
