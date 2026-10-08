import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  NonNegativeInt,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** SDP must pass through byte for byte, so it is never trimmed. */
const Sdp = Schema.String.check(Schema.isNonEmpty());

/**
 * Opens one generation of the voice orchestrator: a realtime Codex session on a
 * fresh session thread, seeded with a briefing built from the orchestrator's
 * stored state. The phone owns the mic and speaker; audio flows between the
 * device and OpenAI on the Codex subscription.
 *
 * There is one orchestrator per server. Opening while a generation is live
 * replaces it, so rotation and reconnect are the same call with a new offer.
 */
export const VoiceSessionOpenInput = Schema.Struct({
  sdpOffer: Sdp,
  /** Opt in because older clients cannot decode startup events. */
  startupProgress: Schema.optional(Schema.Boolean),
  /** Thread the user opened the call from, briefed first. */
  focusThreadId: Schema.optional(ThreadId),
  /** Clients opt in before the server sends the request_notices event. */
  supportsRequestNotices: Schema.optional(Schema.Boolean),
});
export type VoiceSessionOpenInput = typeof VoiceSessionOpenInput.Type;

/** Highest first: the order notices are spoken in a batch. */
export const VoiceNoticeKind = Schema.Literals(["approval", "failed", "input", "completed"]);
export type VoiceNoticeKind = typeof VoiceNoticeKind.Type;

/** Something that happened in a thread, told to the user once. */
export const VoiceNotice = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: VoiceNoticeKind,
  threadId: ThreadId,
  threadTitle: Schema.String,
  /** Runtime question or approval this notice belongs to. */
  requestId: Schema.optional(RuntimeRequestId),
  /** One short sentence, written to be read aloud. */
  text: Schema.String,
  createdAt: Schema.DateTimeUtc,
});
export type VoiceNotice = typeof VoiceNotice.Type;

/** Write actions that need an on-screen yes. */
export const VoiceConfirmAction = Schema.Literals(["launch", "interrupt", "runtime_approval"]);
export type VoiceConfirmAction = typeof VoiceConfirmAction.Type;

/** An action held until the user taps Approve or Deny on the phone. */
export const VoiceConfirmRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  action: VoiceConfirmAction,
  threadId: Schema.optional(ThreadId),
  title: Schema.String,
  detail: Schema.String,
  expiresAt: Schema.DateTimeUtc,
});
export type VoiceConfirmRequest = typeof VoiceConfirmRequest.Type;

/** Why a generation ended. `rotated` means a newer generation replaced it. */
export const VoiceSessionEndReason = Schema.Literals(["hung_up", "rotated", "closed", "error"]);
export type VoiceSessionEndReason = typeof VoiceSessionEndReason.Type;

/** Startup work currently running, with no provider output or session content. */
export const VoiceSessionStartupStage = Schema.Literals([
  "preparing-session",
  "briefing",
  "starting-realtime",
]);
export type VoiceSessionStartupStage = typeof VoiceSessionStartupStage.Type;

/**
 * Events on the `voiceSession.open` stream. `startup` precedes `answer`, and
 * `ended` comes last. `rotate` asks the phone to open the next generation
 * with a fresh offer before this one gets too long. Unsubscribing hangs up this generation.
 */
export const VoiceSessionEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("startup"),
    stage: VoiceSessionStartupStage,
  }),
  Schema.Struct({
    type: Schema.Literal("answer"),
    generation: NonNegativeInt,
    sessionThreadId: ThreadId,
    sdpAnswer: Sdp,
  }),
  Schema.Struct({ type: Schema.Literal("notice"), notice: VoiceNotice }),
  /** Authoritative pending questions and approvals, including after reconnect. */
  Schema.Struct({ type: Schema.Literal("request_notices"), notices: Schema.Array(VoiceNotice) }),
  Schema.Struct({ type: Schema.Literal("confirm"), request: VoiceConfirmRequest }),
  Schema.Struct({
    type: Schema.Literal("confirm_resolved"),
    requestId: TrimmedNonEmptyString,
    approved: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("rotate") }),
  Schema.Struct({
    type: Schema.Literal("ended"),
    reason: VoiceSessionEndReason,
    message: Schema.optional(Schema.String),
  }),
]);
export type VoiceSessionEvent = typeof VoiceSessionEvent.Type;

/** The phone's answer to a `confirm` event. */
export const VoiceSessionRespondInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  approved: Schema.Boolean,
});
export type VoiceSessionRespondInput = typeof VoiceSessionRespondInput.Type;

export const VoiceSessionRespondResult = Schema.Struct({
  /** False when the request already expired or was answered. */
  accepted: Schema.Boolean,
});
export type VoiceSessionRespondResult = typeof VoiceSessionRespondResult.Type;

/**
 * An open topic the orchestrator should come back to. Code opens and closes
 * `thread` items from run events; the voice agent opens and closes `topic`
 * items through its tools.
 */
export const VoiceAgendaItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["thread", "topic"]),
  threadId: Schema.NullOr(ThreadId),
  title: Schema.String,
  detail: Schema.String,
  status: Schema.Literals(["open", "closed"]),
  openedAt: Schema.DateTimeUtc,
  closedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type VoiceAgendaItem = typeof VoiceAgendaItem.Type;

/**
 * Why a voice sidecar refused a call. The sidecar is a separate process from
 * the T3 server, so these never come from `EnvironmentAuthorizationError`.
 */
export class VoiceSidecarError extends Schema.TaggedError<VoiceSidecarError>()(
  "VoiceSidecarError",
  { message: Schema.String },
) {}

/** Served at `GET /voice/info` so a phone can match the sidecar to its environment. */
export const VoiceSidecarInfo = Schema.Struct({
  /** The T3 environment whose threads this sidecar watches and acts on. */
  environmentId: TrimmedNonEmptyString,
  version: Schema.String,
});
export type VoiceSidecarInfo = typeof VoiceSidecarInfo.Type;

export const VOICE_SIDECAR_INFO_PATH = "/voice/info";
export const VOICE_SIDECAR_RPC_PATH = "/voice/rpc";

/**
 * Voice memos: the phone records one message, sends it, and plays the spoken
 * reply. Unlike a call, nothing streams, so a dropped connection only delays
 * the reply.
 *
 * `POST /voice/memo?memoId=…&focusThreadId=…` takes the raw recording as the
 * body (m4a/AAC as `audio/mp4`) and answers with `VoiceMemoReply` once the
 * reply is ready, which can take a minute. Failures answer with
 * `VoiceMemoFailure` and a 4xx or 5xx status.
 */
export const VOICE_SIDECAR_MEMO_PATH = "/voice/memo";

export const VoiceMemoSubmitParams = Schema.Struct({
  /**
   * A UUID the phone picks per recording. Sending the same id again returns
   * the same reply, so retrying after a dropped connection never runs the memo
   * twice.
   */
  memoId: TrimmedNonEmptyString,
  /** Thread the memo was recorded from, so "this thread" means it. */
  focusThreadId: Schema.optional(ThreadId),
});
export type VoiceMemoSubmitParams = typeof VoiceMemoSubmitParams.Type;

export const VoiceMemoReply = Schema.Struct({
  memoId: TrimmedNonEmptyString,
  /** What the server heard. */
  transcript: Schema.String,
  /** What the reply audio says, including any news from other threads. */
  reply: Schema.String,
  /** Path of the spoken reply (`audio/mp4`) on the sidecar, served by `GET`. */
  audioPath: Schema.String,
});
export type VoiceMemoReply = typeof VoiceMemoReply.Type;

export const VoiceMemoFailure = Schema.Struct({ message: Schema.String });
export type VoiceMemoFailure = typeof VoiceMemoFailure.Type;

/**
 * The voice sidecar's RPC surface, served at `VOICE_SIDECAR_RPC_PATH` over a
 * WebSocket. It lives outside `WsRpcGroup` because the T3 server never serves it.
 */
export const VoiceSessionOpenRpc = Rpc.make("voiceSession.open", {
  payload: VoiceSessionOpenInput,
  success: VoiceSessionEvent,
  error: VoiceSidecarError,
  stream: true,
});

export const VoiceSessionRespondRpc = Rpc.make("voiceSession.respond", {
  payload: VoiceSessionRespondInput,
  success: VoiceSessionRespondResult,
  error: VoiceSidecarError,
});

export const VoiceRpcGroup = RpcGroup.make(VoiceSessionOpenRpc, VoiceSessionRespondRpc);
