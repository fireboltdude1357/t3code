import {
  CommandId,
  defaultInstanceIdForDriver,
  MessageId,
  type ProjectId,
  ProviderDriverKind,
  ThreadId,
  type VoiceCallEvent,
  type VoiceCallStartInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { isForkableSourceRunStatus } from "./ThreadForkService.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";
import { type VoiceCallEnd, VoiceForkRegistry } from "./VoiceForkRegistry.ts";

/** The backing agent of every voice call. */
export const VOICE_CALL_MODEL = "gpt-6.1-sol";
const VOICE_CALL_SETUP_TIMEOUT_MS = 120_000;

/** A start failure the phone shows as-is. */
export class VoiceCallStartError extends Schema.TaggedError<VoiceCallStartError>()(
  "VoiceCallStartError",
  { message: Schema.String },
) {}

interface VoiceFork {
  readonly forkThreadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly projectId: ProjectId;
}

export interface VoiceCallServiceShape {
  /**
   * Forks `sourceThreadId`, starts a Codex realtime session on the fork and
   * streams `answer` then `ended`. Interrupting the stream hangs up. However
   * the call ends, realtime stops and the fork is archived.
   */
  readonly start: (input: VoiceCallStartInput) => Stream.Stream<VoiceCallEvent>;
  /** Whether `senderThreadId` is a live voice fork whose parent is `targetThreadId`. */
  readonly isVoiceForkSendingToParent: (
    senderThreadId: ThreadId,
    targetThreadId: ThreadId,
  ) => Effect.Effect<boolean>;
  /** Ends the call on `forkThreadId` because its message reached the parent. */
  readonly markSent: (forkThreadId: ThreadId) => Effect.Effect<void>;
}

export class VoiceCallService extends Context.Service<VoiceCallService, VoiceCallServiceShape>()(
  "t3/orchestration-v2/VoiceCallService",
) {}

/**
 * Standing instructions for the fork's agent, sent as its first message.
 * Each handoff from the voice model carries the call transcript, so the agent
 * checks the user's own confirmation there instead of trusting a summary.
 */
export function voiceForkInstructions(parentThreadId: ThreadId): string {
  return [
    "You are the backing agent for a live voice call. A realtime voice model talks with the user and hands you work along with the call transcript.",
    "Keep every reply short and easy to say aloud: no tables, code blocks, or long lists.",
    "Do not edit files.",
    `The main thread for this call is ${parentThreadId}.`,
    `Send to it only when the transcript shows the voice model read a draft back word for word and the user then clearly said yes. Then call the t3-code tool t3_thread_send with threadId ${parentThreadId} and exactly that draft, and reply "Sent."`,
    "If the user has not confirmed yet, reply with just the draft and do not send.",
    "Reply to this message with just: Ready.",
  ].join("\n");
}

/** Instructions for the realtime voice model. */
export const VOICE_CALL_PROMPT = [
  "You are the voice interface for a T3 Code coding thread. Be brief and conversational.",
  "Hand real work, questions about the code, and lookups to the background agent. It has the thread's full history; you do not.",
  "When the user wants to send something to the main thread: get a draft (ask the agent if it needs thread context), read it back word for word, and ask whether to send it.",
  "When the user says yes, hand off to the agent so it can send. If the user changes anything, read the new draft back and ask again.",
  "You cannot send anything yourself. Never tell the user a message was sent until the agent replies Sent.",
].join("\n");

const isVoiceCallStartError = Schema.is(VoiceCallStartError);
const startFailure = (message: string) => new VoiceCallStartError({ message });

/** Keeps a readable message from any start failure. */
const toStartError = (fallback: string) => (cause: unknown) =>
  isVoiceCallStartError(cause)
    ? cause
    : startFailure(userFacingDispatchErrorMessage(cause) ?? fallback);

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const providerSessions = yield* ProviderSessionManagerV2;
  const crypto = yield* Crypto.Crypto;
  const registry = yield* VoiceForkRegistry;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (tag: string) =>
    uuid.pipe(Effect.map((id) => CommandId.make(`server:voice-call:${tag}:${id}`)));

  const archiveFork = (forkThreadId: ThreadId) =>
    commandId("archive").pipe(
      Effect.flatMap((id) =>
        threads.dispatch({ type: "thread.archive", commandId: id, threadId: forkThreadId }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("voice-call.archive-failed", { forkThreadId, cause }),
      ),
    );

  /** Forks the source and registers the call. Released: unregister, then archive. */
  const openFork = (input: VoiceCallStartInput, end: Deferred.Deferred<VoiceCallEnd>) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const source = yield* threads.getThreadRecords(input.sourceThreadId, ["runs"]);
        const latestRun = source.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
        if (latestRun === undefined) {
          return yield* startFailure("Send a message before starting a voice call.");
        }
        if (!isForkableSourceRunStatus(latestRun.status)) {
          return yield* startFailure(
            "Wait for the current turn to finish before starting a voice call.",
          );
        }
        const forkThreadId = ThreadId.make(yield* uuid);
        yield* threads.dispatch({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "server",
          commandId: yield* commandId("fork"),
          sourceThreadId: input.sourceThreadId,
          targetThreadId: forkThreadId,
          sourcePoint: { type: "latest_stable" },
          title: `Voice: ${source.thread.title}`.slice(0, 120),
        });
        yield* registry.register(forkThreadId, { parentThreadId: input.sourceThreadId, end });
        const fork: VoiceFork = {
          forkThreadId,
          parentThreadId: input.sourceThreadId,
          projectId: source.thread.projectId,
        };
        return fork;
      }),
      ({ forkThreadId }) =>
        registry.unregister(forkThreadId).pipe(Effect.andThen(archiveFork(forkThreadId))),
    );

  /**
   * Switches the fork to a read-only Codex agent and runs its instruction turn.
   *
   * Realtime waits for that turn to finish. The Codex native thread only
   * exists once a turn starts, and the voice model's handoffs start or steer
   * native turns that T3 does not track. Waiting costs one short turn but
   * leaves the fork idle, so no handoff races a T3-tracked run and the agent
   * has its instructions before the first handoff.
   */
  const prepareFork = ({ forkThreadId, parentThreadId, projectId }: VoiceFork) =>
    Effect.gen(function* () {
      yield* threads.dispatch({
        type: "thread.model-selection.set",
        commandId: yield* commandId("model"),
        threadId: forkThreadId,
        modelSelection: {
          instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
          model: VOICE_CALL_MODEL,
        },
      });
      yield* threads.dispatch({
        type: "thread.runtime-mode.set",
        commandId: yield* commandId("runtime-mode"),
        threadId: forkThreadId,
        runtimeMode: "approval-required",
      });
      const sent = yield* threads.sendToThread({
        projectId,
        commandId: yield* commandId("instructions"),
        threadId: forkThreadId,
        messageId: MessageId.make(`voice-call-instructions:${yield* uuid}`),
        text: voiceForkInstructions(parentThreadId),
        attachments: [],
        mode: "auto",
        createdBy: "system",
        creationSource: "server",
      });
      const waited = yield* threads.waitForThread({
        projectId,
        threadId: forkThreadId,
        runId: sent.run.id,
        timeoutMs: VOICE_CALL_SETUP_TIMEOUT_MS,
      });
      if (waited.run?.status !== "completed") {
        return yield* startFailure(
          waited.timedOut
            ? "The voice agent took too long to start."
            : `The voice agent failed to start (${waited.run?.status ?? "no run"}).`,
        );
      }
      const records = yield* threads.getThreadRecords(forkThreadId, ["providerThreads"]);
      const providerThread = records.providerThreads.find(
        (candidate) => candidate.id === records.thread.activeProviderThreadId,
      );
      const runtime =
        providerThread?.providerSessionId == null
          ? undefined
          : Option.getOrUndefined(yield* providerSessions.get(providerThread.providerSessionId));
      if (providerThread === undefined || runtime === undefined) {
        return yield* startFailure("The voice agent's session is not running.");
      }
      if (runtime.startRealtimeCall === undefined) {
        return yield* startFailure("Voice calls need a Codex thread.");
      }
      return { providerThread, startRealtimeCall: runtime.startRealtimeCall };
    });

  const start: VoiceCallServiceShape["start"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const end = yield* Deferred.make<VoiceCallEnd>();
        const fork = yield* openFork(input, end);
        const { providerThread, startRealtimeCall } = yield* prepareFork(fork);
        const realtime = yield* Effect.acquireRelease(
          startRealtimeCall({
            providerThread,
            sdpOffer: input.sdpOffer,
            prompt: VOICE_CALL_PROMPT,
          }),
          (call) => call.stop.pipe(Effect.ignore),
        );
        const ended = Effect.raceFirst(
          Deferred.await(end),
          realtime.ended.pipe(
            Effect.map((result): VoiceCallEnd =>
              result.type === "error"
                ? { reason: "error", message: result.message }
                : { reason: "closed" },
            ),
          ),
        );
        const answer: VoiceCallEvent = {
          type: "answer",
          forkThreadId: fork.forkThreadId,
          sdpAnswer: realtime.sdpAnswer,
        };
        return Stream.make(answer).pipe(
          Stream.concat(
            Stream.fromEffect(
              ended.pipe(
                Effect.map((result): VoiceCallEvent => ({
                  type: "ended",
                  reason: result.reason,
                  ...(result.message === undefined ? {} : { message: result.message }),
                })),
              ),
            ),
          ),
        );
      }).pipe(Effect.mapError(toStartError("The voice call could not start."))),
    ).pipe(
      Stream.catchCause((cause) => {
        const failed: VoiceCallEvent = {
          type: "ended",
          reason: "error",
          message: Option.match(Cause.findErrorOption(cause), {
            onNone: () => "The voice call failed.",
            onSome: (error) => error.message,
          }),
        };
        return Stream.make(failed);
      }),
    );

  return VoiceCallService.of({
    start,
    isVoiceForkSendingToParent: (senderThreadId, targetThreadId) =>
      registry
        .get(senderThreadId)
        .pipe(
          Effect.map((fork) =>
            Option.exists(fork, (active) => active.parentThreadId === targetThreadId),
          ),
        ),
    markSent: (forkThreadId) =>
      registry.get(forkThreadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (active) =>
              Deferred.succeed(active.end, { reason: "sent" }).pipe(Effect.asVoid),
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(VoiceCallService, make);
