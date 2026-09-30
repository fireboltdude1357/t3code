import type { VoiceCallEndReason, VoiceCallEvent } from "@t3tools/contracts";

/**
 * What the call sheet shows. `connecting` covers the microphone prompt, the
 * WebRTC offer, and the wait for the server's answer.
 */
export type VoiceCallState =
  | { readonly phase: "connecting" }
  | {
      readonly phase: "live";
      readonly muted: boolean;
      /** The assistant's current spoken line. `done` once GPT-Live finishes the turn. */
      readonly transcript: { readonly text: string; readonly done: boolean } | null;
    }
  | {
      readonly phase: "ended";
      readonly reason: VoiceCallEndReason;
      readonly message: string | null;
    }
  | { readonly phase: "microphone-denied" };

export type VoiceCallAction =
  | { readonly type: "server"; readonly event: VoiceCallEvent }
  /** The server stream finished without an `ended` event. */
  | { readonly type: "stream-completed" }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "microphone-denied" }
  | { readonly type: "toggle-mute" }
  /** A parsed JSON event from the `oai-events` data channel. */
  | { readonly type: "realtime"; readonly event: unknown };

export const INITIAL_VOICE_CALL_STATE: VoiceCallState = { phase: "connecting" };

type TranscriptUpdate =
  | { readonly type: "chunk"; readonly text: string }
  | { readonly type: "line"; readonly text: string };

/**
 * Reads GPT-Live (realtime v3) transcript events: `output_transcript.added`
 * carries a chunk in `item.text`, and an assistant `turn.done` carries the
 * whole line in `turn.transcript`.
 */
function transcriptUpdate(event: unknown): TranscriptUpdate | null {
  if (typeof event !== "object" || event === null) return null;
  const { type, item, turn } = event as Record<string, unknown>;
  const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  if (type === "output_transcript.added") {
    const text = field(item, "text");
    return typeof text === "string" ? { type: "chunk", text } : null;
  }
  if (type === "turn.done" && field(turn, "role") === "assistant") {
    const text = field(turn, "transcript");
    return typeof text === "string" ? { type: "line", text } : null;
  }
  return null;
}

/** Pure transitions for the call sheet. `ended` and `microphone-denied` are terminal. */
export function voiceCallReducer(state: VoiceCallState, action: VoiceCallAction): VoiceCallState {
  if (state.phase === "ended" || state.phase === "microphone-denied") return state;
  switch (action.type) {
    case "server":
      if (action.event.type === "ended") {
        return {
          phase: "ended",
          reason: action.event.reason,
          message: action.event.message ?? null,
        };
      }
      return state.phase === "connecting"
        ? { phase: "live", muted: false, transcript: null }
        : state;
    case "stream-completed":
      return { phase: "ended", reason: "closed", message: null };
    case "failed":
      return { phase: "ended", reason: "error", message: action.message };
    case "microphone-denied":
      return { phase: "microphone-denied" };
    case "toggle-mute":
      return state.phase === "live" ? { ...state, muted: !state.muted } : state;
    case "realtime": {
      if (state.phase !== "live") return state;
      const update = transcriptUpdate(action.event);
      if (update === null) return state;
      if (update.type === "line") {
        return { ...state, transcript: { text: update.text.trim(), done: true } };
      }
      const previous =
        state.transcript === null || state.transcript.done ? "" : state.transcript.text;
      return { ...state, transcript: { text: previous + update.text, done: false } };
    }
  }
}
