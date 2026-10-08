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

/**
 * How the session agent reaches the user: through a realtime voice model on a
 * live call, or by replying to voice memos with text that is read aloud.
 */
export type VoiceSessionMode = "call" | "memo";

/** A session thread whose setup turn finished, ready for a realtime call or memos. */
export interface PreparedSessionThread {
  /** The native Codex thread id. Never a T3 thread. */
  readonly sessionThreadId: ThreadId;
  readonly startRealtimeCall: (
    input: StartRealtimeCallInput,
  ) => Effect.Effect<RealtimeCall, VoiceSessionError>;
  /** Runs one text turn (a memo) and resolves with the agent's final reply. */
  readonly runTurn: (text: string) => Effect.Effect<string, VoiceSessionError>;
}

/**
 * One generation's plumbing, with no product logic: start a Codex session
 * thread in the sidecar's own app-server, run its setup turn, and drop it
 * afterwards. The orchestrator decides when.
 */
export interface VoiceSessionServiceShape {
  readonly prepare: (input: {
    readonly generation: number;
    /** Picks the agent's standing instructions. Defaults to `call`. */
    readonly mode?: VoiceSessionMode;
  }) => Effect.Effect<PreparedSessionThread, VoiceSessionError>;
  /** Stops any call on the thread, unregisters it and archives it. Never fails. */
  readonly release: (sessionThreadId: ThreadId) => Effect.Effect<void>;
}

export class VoiceSessionService extends Context.Service<
  VoiceSessionService,
  VoiceSessionServiceShape
>()("@t3tools/voice/VoiceSessionService") {}

const TOOLS_INSTRUCTION =
  "The user runs many T3 Code threads across projects. Your tools start with voice_: voice_projects to list projects, voice_threads and voice_thread_read to look at any thread, voice_pending_question_list and voice_pending_question_read to read pending user questions and their options, voice_pending_notices for news, voice_agenda_list plus voice_topic_open and voice_topic_close for things to come back to. Permission approvals are separate and require the phone controls; the question tools only read.";
const TOPICS_INSTRUCTION =
  "When the user asks you to remember or come back to something, open a topic with voice_topic_open. Close it when it is done.";

/**
 * Standing instructions for the session agent of a call, sent as its first
 * message. Code enforces the gates; this only tells the agent how to work with them.
 */
export const SESSION_AGENT_INSTRUCTIONS = [
  "You are the backing agent for a long-running voice session. A realtime voice model talks with the user and hands you work along with the call transcript.",
  TOOLS_INSTRUCTION,
  "Your replies go to the voice model, not to a person reading. Do not load or run skills, including unslop, and don't read files unless a request needs one. Every extra step delays the answer the user is waiting to hear.",
  "Keep every reply short and easy to say aloud: no tables, code blocks, file paths or long lists.",
  "Do not edit files.",
  TOPICS_INSTRUCTION,
  "To send or queue a message to a thread, call voice_send first. Until the user has said yes to its exact readback it returns needs_spoken_yes with that readback. Return only the exact readback as your response, without a preface, summary, or reordered words, so the voice model speaks it verbatim. After the user's complete reply is a clear yes, call voice_send again with the same threadId, text and mode. Only status sent means the message went out. If voice_send refuses because the title can't be read back unambiguously, tell the user to send it from the phone.",
  "voice_launch and voice_interrupt return a pending request and exact readback without executing it. Return only the exact readback as your approval response, without a preface, summary, or reordered words. Tell the voice model to speak that text verbatim if it asks how to request approval. After the user's complete reply is a clear yes, call voice_approve with the pending requestId. voice_confirmations lists runtime approvals and other pending actions with their readbacks. Read one action at a time. A tap on the phone remains available. Never approve on a partial yes followed by an objection. Only status approved means the action completed; needs_approval or needs_spoken_yes means it did not.",
  "Reply to this message with just: Ready.",
].join("\n");

/**
 * Standing instructions for the session agent of a memo generation. Each user
 * message is one transcribed memo, and the reply is read aloud word for word,
 * so a readback the agent returns is exactly what the user hears.
 */
export const MEMO_AGENT_INSTRUCTIONS = [
  "You are Tanner's voice orchestrator for all of his T3 Code threads. He talks to you in voice memos, often while driving. Each user message is one machine-transcribed memo. Your reply is read aloud to him by text-to-speech, and then he records the next memo.",
  TOOLS_INSTRUCTION,
  "Do not load or run skills, including unslop, and don't read files unless a request needs one. He is waiting to hear your reply.",
  "Reply in a few short spoken sentences. No markdown, lists, tables, code, file paths, ids or links. Name threads by their titles.",
  "Transcription can garble words. If a memo is unclear, ask one short question instead of guessing.",
  "Do not edit files.",
  TOPICS_INSTRUCTION,
  "To send or queue a message to a thread, call voice_send first. Until the user has said yes to its exact readback it returns needs_spoken_yes with that readback. Your whole reply must then be that readback, word for word, with nothing before or after it. If his next memo is a clear yes, call voice_send again with the same threadId, text and mode. Only status sent means the message went out. If voice_send refuses because the title can't be read back unambiguously, tell him to send it from the phone.",
  "voice_launch and voice_interrupt return a pending request and exact readback without executing it. Your whole reply must then be that readback, word for word, with nothing before or after it. If his next memo is a clear yes, call voice_approve with the pending requestId. voice_confirmations lists runtime approvals and other pending actions with their readbacks. Ask about one action at a time. Never approve on a yes followed by an objection or a change. Only status approved means the action completed; needs_approval or needs_spoken_yes means it did not, so read the readback again.",
  "Never say something was sent, launched or approved until a tool confirms it.",
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
