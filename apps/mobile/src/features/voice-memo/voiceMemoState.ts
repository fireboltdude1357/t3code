import { VoiceMemoFailure, VoiceMemoReply, type ThreadId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/**
 * One memo moves idle → starting → recording → sending → waiting →
 * downloading → playing → ready. `failed` keeps the recording and reply so
 * Retry can pick up the stage that failed.
 */
export type VoiceMemoStatus =
  | "idle"
  | "starting"
  | "recording"
  | "sending"
  | "waiting"
  | "downloading"
  | "playing"
  | "ready"
  | "failed"
  | "microphone-denied";

/** The step that failed, which is the step Retry runs again. */
export type VoiceMemoStage = "record" | "submit" | "download" | "playback";

/** A finished recording. Retries resend the same id and file, so the server runs it once. */
export interface VoiceMemoRecording {
  /** A UUID; the sidecar rejects anything else. */
  readonly id: string;
  readonly fileUri: string;
  readonly focusThreadId: ThreadId | null;
}

export interface VoiceMemoState {
  readonly status: VoiceMemoStatus;
  /** Sent with the next recording. */
  readonly focusThreadId: ThreadId | null;
  /**
   * Goes up for each new recording and on reset. Async results carry the
   * session they started in, and the reducer drops ones from older sessions.
   */
  readonly session: number;
  readonly recordingStartedAt: number | null;
  readonly memo: VoiceMemoRecording | null;
  readonly reply: VoiceMemoReply | null;
  readonly replyFileUri: string | null;
  /** Goes up each time the reply should start playing from the top. */
  readonly playback: number;
  /** The last attempt could not reach the server and another is coming. */
  readonly retrying: boolean;
  readonly error: { readonly stage: VoiceMemoStage; readonly message: string } | null;
}

export const INITIAL_VOICE_MEMO_STATE: VoiceMemoState = {
  status: "idle",
  focusThreadId: null,
  session: 0,
  recordingStartedAt: null,
  memo: null,
  reply: null,
  replyFileUri: null,
  playback: 0,
  retrying: false,
  error: null,
};

export type VoiceMemoAction =
  | { readonly type: "open"; readonly focusThreadId: ThreadId | null }
  | { readonly type: "record" }
  | { readonly type: "recording-started"; readonly session: number; readonly at: number }
  | { readonly type: "microphone-denied"; readonly session: number }
  | { readonly type: "cancel-recording" }
  | { readonly type: "send" }
  | { readonly type: "recorded"; readonly session: number; readonly memo: VoiceMemoRecording }
  | { readonly type: "uploaded"; readonly session: number }
  | { readonly type: "retrying"; readonly session: number }
  | { readonly type: "reply-received"; readonly session: number; readonly reply: VoiceMemoReply }
  | { readonly type: "reply-downloaded"; readonly session: number; readonly fileUri: string }
  | { readonly type: "play" }
  | { readonly type: "stop-playback" }
  | { readonly type: "playback-ended"; readonly session: number }
  | {
      readonly type: "failed";
      readonly session: number;
      readonly stage: VoiceMemoStage;
      readonly message: string;
    }
  | { readonly type: "retry" }
  | { readonly type: "reset" }
  /** The sheet closed: drop a recording in progress and stop playback. Network work continues. */
  | { readonly type: "sheet-closed" };

/** Longest memo before it sends on its own. The server's transcriber stops at 180 s. */
export const VOICE_MEMO_MAX_RECORDING_MS = 170_000;

/** Statuses with a request or download running. */
export function isVoiceMemoInFlight(state: VoiceMemoState): boolean {
  return state.status === "sending" || state.status === "waiting" || state.status === "downloading";
}

/** Where a cancelled recording or stopped playback lands. */
function settled(state: VoiceMemoState): VoiceMemoState {
  return {
    ...state,
    status: state.reply !== null && state.replyFileUri !== null ? "ready" : "idle",
    recordingStartedAt: null,
    retrying: false,
  };
}

const RETRY_STATUS: Record<VoiceMemoStage, VoiceMemoStatus> = {
  record: "starting",
  submit: "sending",
  download: "downloading",
  playback: "playing",
};

export function voiceMemoReducer(state: VoiceMemoState, action: VoiceMemoAction): VoiceMemoState {
  switch (action.type) {
    case "open":
      return {
        ...(state.status === "microphone-denied" ? settled(state) : state),
        focusThreadId: action.focusThreadId,
      };
    case "record":
      if (
        state.status === "starting" ||
        state.status === "recording" ||
        isVoiceMemoInFlight(state)
      ) {
        return state;
      }
      return {
        ...state,
        status: "starting",
        session: state.session + 1,
        recordingStartedAt: null,
        retrying: false,
        error: null,
      };
    case "recording-started":
      if (action.session !== state.session || state.status !== "starting") return state;
      return { ...state, status: "recording", recordingStartedAt: action.at };
    case "microphone-denied":
      if (action.session !== state.session || state.status !== "starting") return state;
      return { ...state, status: "microphone-denied" };
    case "cancel-recording":
      if (state.status !== "starting" && state.status !== "recording") return state;
      return settled(state);
    case "send":
      if (state.status !== "recording") return state;
      // The new memo replaces the last one, so its files can go.
      return {
        ...state,
        status: "sending",
        recordingStartedAt: null,
        memo: null,
        reply: null,
        replyFileUri: null,
      };
    case "recorded":
      if (action.session !== state.session || state.status !== "sending") return state;
      return { ...state, memo: action.memo };
    case "uploaded":
      // Also from waiting: a retry after the first upload uploads again.
      if (
        action.session !== state.session ||
        (state.status !== "sending" && state.status !== "waiting")
      ) {
        return state;
      }
      return { ...state, status: "waiting", retrying: false };
    case "retrying":
      if (action.session !== state.session || !isVoiceMemoInFlight(state)) return state;
      return { ...state, retrying: true };
    case "reply-received":
      if (
        action.session !== state.session ||
        (state.status !== "sending" && state.status !== "waiting")
      ) {
        return state;
      }
      return { ...state, status: "downloading", reply: action.reply, retrying: false };
    case "reply-downloaded":
      if (action.session !== state.session || state.status !== "downloading") return state;
      return {
        ...state,
        status: "playing",
        replyFileUri: action.fileUri,
        playback: state.playback + 1,
        retrying: false,
      };
    case "play":
      if ((state.status !== "ready" && state.status !== "playing") || state.replyFileUri === null) {
        return state;
      }
      return { ...state, status: "playing", playback: state.playback + 1 };
    case "stop-playback":
      return state.status === "playing" ? settled(state) : state;
    case "playback-ended":
      if (action.session !== state.session || state.status !== "playing") return state;
      return settled(state);
    case "failed":
      if (action.session !== state.session) return state;
      if (state.status === "idle" || state.status === "ready" || state.status === "failed") {
        return state;
      }
      return {
        ...state,
        status: "failed",
        recordingStartedAt: null,
        retrying: false,
        error: { stage: action.stage, message: action.message },
      };
    case "retry": {
      if (state.status !== "failed" || state.error === null) return state;
      const { stage } = state.error;
      // A stage can only run again with what it needs; otherwise record anew.
      const ready =
        (stage === "submit" && state.memo !== null) ||
        (stage === "download" && state.reply !== null) ||
        (stage === "playback" && state.replyFileUri !== null);
      if (!ready) {
        return voiceMemoReducer({ ...state, status: "idle", error: null }, { type: "record" });
      }
      return {
        ...state,
        status: RETRY_STATUS[stage],
        playback: stage === "playback" ? state.playback + 1 : state.playback,
        retrying: false,
        error: null,
      };
    }
    case "reset":
      if (state.status === "starting" || state.status === "recording") return state;
      return {
        ...INITIAL_VOICE_MEMO_STATE,
        focusThreadId: state.focusThreadId,
        session: state.session + 1,
        playback: state.playback,
      };
    case "sheet-closed":
      if (state.status === "starting" || state.status === "recording") return settled(state);
      if (state.status === "playing") return settled(state);
      return state;
  }
}

/** The request never got a usable answer: no connection, a timeout, or a 503. Retried. */
export class VoiceMemoOffline extends Data.TaggedError("VoiceMemoOffline")<{}> {}

/** The server answered and retrying the same request would not help. */
export class VoiceMemoRejected extends Data.TaggedError("VoiceMemoRejected")<{
  readonly message: string;
}> {}

export type VoiceMemoRequestError = VoiceMemoOffline | VoiceMemoRejected;

const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(VoiceMemoReply));
const decodeFailure = Schema.decodeUnknownOption(Schema.fromJsonString(VoiceMemoFailure));

/** Turns the sidecar's answer to `POST /voice/memo` into a reply or a typed error. */
export function readVoiceMemoResponse(
  memoId: string,
  status: number,
  body: string,
): Effect.Effect<VoiceMemoReply, VoiceMemoRequestError> {
  if (status === 503) return Effect.fail(new VoiceMemoOffline());
  if (status < 200 || status >= 300) {
    const message = Option.match(decodeFailure(body), {
      onNone: () => `The voice server answered with status ${status}.`,
      onSome: (failure) => failure.message,
    });
    return Effect.fail(new VoiceMemoRejected({ message }));
  }
  return Option.match(decodeReply(body), {
    onNone: () =>
      Effect.fail(new VoiceMemoRejected({ message: "The voice server sent an unreadable reply." })),
    onSome: (reply) =>
      reply.memoId === memoId
        ? Effect.succeed(reply)
        : Effect.fail(
            new VoiceMemoRejected({ message: "The voice server answered a different memo." }),
          ),
  });
}

const MAX_RETRY_DELAY = Duration.seconds(15);
export const VOICE_MEMO_RETRY_WINDOW = Duration.minutes(10);

/** 2 s, 4 s, 8 s, then every 15 s, for up to 10 minutes. */
const voiceMemoRetrySchedule = Schedule.exponential("2 seconds").pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, MAX_RETRY_DELAY))),
  Schedule.upTo({ duration: VOICE_MEMO_RETRY_WINDOW }),
);

/**
 * Runs `attempt` again while it fails with `VoiceMemoOffline`, calling
 * `onRetrying` before each wait. A rejection or the end of the window fails.
 */
export function retryWhileOffline<A, R>(
  attempt: Effect.Effect<A, VoiceMemoRequestError, R>,
  onRetrying: () => void,
): Effect.Effect<A, VoiceMemoRequestError, R> {
  return attempt.pipe(
    Effect.tapError((error) =>
      error._tag === "VoiceMemoOffline" ? Effect.sync(onRetrying) : Effect.void,
    ),
    Effect.retry({
      schedule: voiceMemoRetrySchedule,
      while: (error) => error._tag === "VoiceMemoOffline",
    }),
  );
}

/** What the user reads when a request finally fails. */
export function voiceMemoErrorMessage(error: VoiceMemoRequestError): string {
  return error._tag === "VoiceMemoOffline"
    ? "Could not reach the voice server for 10 minutes."
    : error.message;
}
