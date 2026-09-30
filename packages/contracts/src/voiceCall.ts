import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/** SDP must pass through byte for byte, so it is never trimmed. */
const Sdp = Schema.String.check(Schema.isNonEmpty());

/**
 * Starts a realtime Codex voice call on a fork of `sourceThreadId`.
 * The client owns the microphone and speaker: it sends its WebRTC SDP offer and
 * the audio then flows between the device and OpenAI on the Codex subscription.
 */
export const VoiceCallStartInput = Schema.Struct({
  sourceThreadId: ThreadId,
  sdpOffer: Sdp,
});
export type VoiceCallStartInput = typeof VoiceCallStartInput.Type;

/** Why a voice call ended. `sent` means the fork delivered a message to its parent. */
export const VoiceCallEndReason = Schema.Literals(["sent", "hung_up", "closed", "error"]);
export type VoiceCallEndReason = typeof VoiceCallEndReason.Type;

/**
 * Events on the `voiceCall.start` stream. `answer` arrives once; `ended` is last.
 * Unsubscribing hangs up: the server stops realtime and archives the fork.
 */
export const VoiceCallEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("answer"),
    forkThreadId: ThreadId,
    sdpAnswer: Sdp,
  }),
  Schema.Struct({
    type: Schema.Literal("ended"),
    reason: VoiceCallEndReason,
    message: Schema.optional(Schema.String),
  }),
]);
export type VoiceCallEvent = typeof VoiceCallEvent.Type;
