import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The backing agent of every voice session. */
export const VOICE_SESSION_MODEL = "gpt-6.1-sol";

/** A failure the phone shows as-is. */
export class VoiceSessionError extends Schema.TaggedError<VoiceSessionError>()(
  "VoiceSessionError",
  { message: Schema.String },
) {}

export type RealtimeTextRole = "user" | "assistant" | "developer";

/** Why a realtime call's transport stopped. */
export type RealtimeCallEnd =
  | { readonly type: "closed"; readonly reason: string | null }
  | { readonly type: "error"; readonly message: string };

/** A live GPT-Live call on a session thread. */
export interface RealtimeCall {
  readonly sdpAnswer: string;
  /** Resolves once when Codex closes or fails the session. */
  readonly ended: Effect.Effect<RealtimeCallEnd>;
  /** Stops the session. Safe to call after it already ended. */
  readonly stop: Effect.Effect<void, VoiceSessionError>;
  /** Adds text to the conversation. `developer` text is context, not speech. */
  readonly appendText: (input: {
    readonly text: string;
    readonly role: RealtimeTextRole;
  }) => Effect.Effect<void, VoiceSessionError>;
  /** Gives the voice model text to say aloud now, as its own words. */
  readonly appendSpeech: (text: string) => Effect.Effect<void, VoiceSessionError>;
}

export interface StartRealtimeCallInput {
  readonly sdpOffer: string;
  /** Instructions for the voice model. */
  readonly prompt: string;
  /** History the session starts with (Codex caps this at 128 items). */
  readonly initialItems?: ReadonlyArray<{
    readonly role: RealtimeTextRole;
    readonly text: string;
  }>;
  /** Developer instructions for the backing agent when the session starts. */
  readonly agentStartInstructions?: string;
  /** Called whenever either side is speaking (transcript deltas), with who it is. */
  readonly onActivity?: (role: "user" | "assistant") => Effect.Effect<void>;
  /** Called with each final transcript part while the session is live. */
  readonly onTranscript?: (part: {
    readonly role: "user" | "assistant";
    readonly text: string;
  }) => Effect.Effect<void>;
}

/** A session thread whose setup turn finished, ready for a realtime call. */
export interface PreparedSessionThread {
  /** The native Codex thread id. Never a T3 thread. */
  readonly sessionThreadId: ThreadId;
  readonly startRealtimeCall: (
    input: StartRealtimeCallInput,
  ) => Effect.Effect<RealtimeCall, VoiceSessionError>;
}

/**
 * One generation's plumbing, with no product logic: start a Codex session
 * thread in the sidecar's own app-server, run its setup turn, and drop it
 * afterwards. The orchestrator decides when.
 */
export interface VoiceSessionServiceShape {
  readonly prepare: (input: {
    readonly generation: number;
  }) => Effect.Effect<PreparedSessionThread, VoiceSessionError>;
  /** Stops any call on the thread, unregisters it and archives it. Never fails. */
  readonly release: (sessionThreadId: ThreadId) => Effect.Effect<void>;
}

export class VoiceSessionService extends Context.Service<
  VoiceSessionService,
  VoiceSessionServiceShape
>()("@t3tools/voice/VoiceSessionService") {}

/**
 * Standing instructions for the session agent, sent as its first message.
 * Code enforces the gates; this only tells the agent how to work with them.
 */
export const SESSION_AGENT_INSTRUCTIONS = [
  "You are the backing agent for a long-running voice session. A realtime voice model talks with the user and hands you work along with the call transcript.",
  "The user runs many T3 Code threads across projects. Your tools start with voice_: voice_projects to list projects, voice_threads and voice_thread_read to look at any thread, voice_pending_question_list and voice_pending_question_read to read pending user questions and their options, voice_pending_notices for news, voice_agenda_list plus voice_topic_open and voice_topic_close for things to come back to. Permission approvals are separate and require the phone controls; the question tools only read.",
  "Your replies go to the voice model, not to a person reading. Do not load or run skills, including unslop, and don't read files unless a request needs one. Every extra step delays the answer the user is waiting to hear.",
  "Keep every reply short and easy to say aloud: no tables, code blocks, file paths or long lists.",
  "Do not edit files.",
  "When the user asks you to remember or come back to something, open a topic with voice_topic_open. Close it when it is done.",
  "To send or queue a message to a thread, call voice_send first. Until the user has said yes to its exact readback it returns needs_spoken_yes with that readback. Return only the exact readback as your response, without a preface, summary, or reordered words, so the voice model speaks it verbatim. After the user's complete reply is a clear yes, call voice_send again with the same threadId, text and mode. Only status sent means the message went out. If voice_send refuses because the title can't be read back unambiguously, tell the user to send it from the phone.",
  "voice_launch and voice_interrupt return a pending request and exact readback without executing it. Return only the exact readback as your approval response, without a preface, summary, or reordered words. Tell the voice model to speak that text verbatim if it asks how to request approval. After the user's complete reply is a clear yes, call voice_approve with the pending requestId. voice_confirmations lists runtime approvals and other pending actions with their readbacks. Read one action at a time. A tap on the phone remains available. Never approve on a partial yes followed by an objection. Only status approved means the action completed; needs_approval or needs_spoken_yes means it did not.",
  "Reply to this message with just: Ready.",
].join("\n");

/**
 * Every tool the session agent may call. Codex runs the session read-only with
 * approvals off, so each one is pre-approved; the tools check their own gates.
 */
export const VOICE_SESSION_TOOLS = [
  "voice_projects",
  "voice_threads",
  "voice_thread_read",
  "voice_pending_question_list",
  "voice_pending_question_read",
  "voice_pending_notices",
  "voice_agenda_list",
  "voice_topic_open",
  "voice_topic_close",
  "voice_send",
  "voice_launch",
  "voice_interrupt",
  "voice_confirmations",
  "voice_approve",
] as const;
