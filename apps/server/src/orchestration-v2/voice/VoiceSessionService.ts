import {
  CommandId,
  defaultInstanceIdForDriver,
  MessageId,
  type OrchestrationV2ProviderThread,
  type ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProviderAdapterV2SessionRuntime } from "../ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import { ThreadManagementService } from "../ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../UserFacingErrors.ts";
import { VoiceSessionRegistry } from "./VoiceSessionRegistry.ts";

/** The backing agent of every voice session. */
export const VOICE_SESSION_MODEL = "gpt-6.1-sol";
const SETUP_TIMEOUT_MS = 120_000;

/** A failure the phone shows as-is. */
export class VoiceSessionError extends Schema.TaggedError<VoiceSessionError>()(
  "VoiceSessionError",
  { message: Schema.String },
) {}

/** A session thread whose setup turn finished, ready for a realtime call. */
export interface PreparedSessionThread {
  readonly sessionThreadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly startRealtimeCall: NonNullable<ProviderAdapterV2SessionRuntime["startRealtimeCall"]>;
}

/**
 * One generation's plumbing, with no product logic: create a session thread,
 * run its setup turn, and archive it afterwards. The orchestrator decides when.
 */
export interface VoiceSessionServiceShape {
  readonly prepare: (input: {
    readonly projectId: ProjectId;
    readonly generation: number;
  }) => Effect.Effect<PreparedSessionThread, VoiceSessionError>;
  /** Unregisters and archives a session thread. Never fails. */
  readonly release: (sessionThreadId: ThreadId) => Effect.Effect<void>;
}

export class VoiceSessionService extends Context.Service<
  VoiceSessionService,
  VoiceSessionServiceShape
>()("t3/orchestration-v2/voice/VoiceSessionService") {}

/**
 * Standing instructions for the session agent, sent as its first message.
 * Code enforces the gates; this only tells the agent how to work with them.
 */
export const SESSION_AGENT_INSTRUCTIONS = [
  "You are the backing agent for a long-running voice session. A realtime voice model talks with the user and hands you work along with the call transcript.",
  "The user runs many T3 Code threads across projects. Your tools start with voice_: voice_threads and voice_thread_read to look at any thread, voice_pending_notices for news, voice_agenda_list plus voice_topic_open and voice_topic_close for things to come back to.",
  "Keep every reply short and easy to say aloud: no tables, code blocks, file paths or long lists.",
  "Do not edit files.",
  "When the user asks you to remember or come back to something, open a topic with voice_topic_open. Close it when it is done.",
  "To send or queue a message to a thread, call voice_send only after the voice model read the exact draft back and the user said yes. The server checks the transcript and refuses otherwise; if refused, reply with the draft so it can be read back.",
  "voice_launch and voice_interrupt put an Approve button on the user's phone and wait for it. Tell the user to tap it.",
  "Reply to this message with just: Ready.",
].join("\n");

const toSessionError = (fallback: string) => (cause: unknown) =>
  Schema.is(VoiceSessionError)(cause)
    ? cause
    : new VoiceSessionError({ message: userFacingDispatchErrorMessage(cause) ?? fallback });

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const providerSessions = yield* ProviderSessionManagerV2;
  const registry = yield* VoiceSessionRegistry;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (tag: string) =>
    uuid.pipe(Effect.map((id) => CommandId.make(`server:voice-session:${tag}:${id}`)));
  const fail = (message: string) => Effect.fail(new VoiceSessionError({ message }));

  const release: VoiceSessionServiceShape["release"] = (sessionThreadId) =>
    registry.unregister(sessionThreadId).pipe(
      Effect.andThen(commandId("archive")),
      Effect.flatMap((id) =>
        threads.dispatch({ type: "thread.archive", commandId: id, threadId: sessionThreadId }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("voice-session.archive-failed", { sessionThreadId, cause }),
      ),
    );

  /**
   * Realtime waits for the setup turn to finish. The Codex native thread only
   * exists once a turn starts, and the voice model's handoffs start native
   * turns T3 does not track. An idle thread means no handoff races a tracked
   * run, and the agent has its instructions before the first handoff.
   */
  const setUp = (projectId: ProjectId, sessionThreadId: ThreadId) =>
    Effect.gen(function* () {
      const sent = yield* threads.sendToThread({
        projectId,
        commandId: yield* commandId("instructions"),
        threadId: sessionThreadId,
        messageId: MessageId.make(`voice-session-instructions:${yield* uuid}`),
        text: SESSION_AGENT_INSTRUCTIONS,
        attachments: [],
        mode: "auto",
        createdBy: "system",
        creationSource: "server",
      });
      const waited = yield* threads.waitForThread({
        projectId,
        threadId: sessionThreadId,
        runId: sent.run.id,
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      if (waited.run?.status !== "completed") {
        return yield* fail(
          waited.timedOut
            ? "The voice agent took too long to start."
            : `The voice agent failed to start (${waited.run?.status ?? "no run"}).`,
        );
      }
      const records = yield* threads.getThreadRecords(sessionThreadId, ["providerThreads"]);
      const providerThread = records.providerThreads.find(
        (candidate) => candidate.id === records.thread.activeProviderThreadId,
      );
      const runtime =
        providerThread?.providerSessionId == null
          ? undefined
          : Option.getOrUndefined(yield* providerSessions.get(providerThread.providerSessionId));
      if (providerThread === undefined || runtime === undefined) {
        return yield* fail("The voice agent's session is not running.");
      }
      if (runtime.startRealtimeCall === undefined) {
        return yield* fail("Voice sessions need a Codex thread.");
      }
      const prepared: PreparedSessionThread = {
        sessionThreadId,
        providerThread,
        startRealtimeCall: runtime.startRealtimeCall,
      };
      return prepared;
    });

  const prepare: VoiceSessionServiceShape["prepare"] = ({ projectId, generation }) =>
    Effect.gen(function* () {
      const sessionThreadId = ThreadId.make(yield* uuid);
      yield* registry.register(sessionThreadId);
      yield* threads.dispatch({
        type: "thread.create",
        commandId: yield* commandId("create"),
        threadId: sessionThreadId,
        projectId,
        title: `Voice session ${generation}`,
        modelSelection: {
          instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
          model: VOICE_SESSION_MODEL,
        },
        // The registry's runtime policy overrides this with read-only, approvals off.
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      });
      return yield* setUp(projectId, sessionThreadId).pipe(
        Effect.onError(() => release(sessionThreadId)),
      );
    }).pipe(Effect.mapError(toSessionError("The voice session could not start.")));

  return VoiceSessionService.of({ prepare, release });
});

export const layer = Layer.effect(VoiceSessionService, make);
