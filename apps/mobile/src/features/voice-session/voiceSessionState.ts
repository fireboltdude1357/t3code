import type {
  EnvironmentId,
  ThreadId,
  VoiceConfirmRequest,
  VoiceNotice,
  VoiceSessionEndReason,
  VoiceSessionEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * `connecting` waits for connected audio, `live` has audio playing (a
 * rotation may be opening the next generation underneath), and `reconnecting`
 * lost its audio and is opening a replacement.
 */
export type VoiceSessionStatus =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "ended"
  | "failed"
  | "microphone-denied";

export const STARTUP_LABELS = {
  microphone: "Checking microphone access",
  "preparing-audio": "Preparing microphone and connection",
  "contacting-server": "Contacting the server",
  "preparing-session": "Preparing the Codex session",
  briefing: "Briefing the voice agent",
  "starting-realtime": "Starting Codex live voice",
  "connecting-audio": "Connecting call audio",
  connected: "Call audio connected",
  retrying: "Connection lost. Retrying",
  failed: "Call startup failed",
  cancelled: "Call cancelled",
  "microphone-denied": "Microphone permission denied",
} as const;
export type VoiceStartupStage = keyof typeof STARTUP_LABELS;
export interface VoiceStartupEntry {
  readonly stage: VoiceStartupStage;
  readonly at: number;
  readonly attempt: number;
}

export interface VoiceSessionState {
  readonly status: VoiceSessionStatus;
  readonly startupLog: ReadonlyArray<VoiceStartupEntry>;
  readonly environmentId: EnvironmentId | null;
  /** Sent with each open until a generation answers, so the first briefing leads with it. */
  readonly focusThreadId: ThreadId | null;
  /**
   * Local id of the newest generation the phone asked for. It never goes
   * down, so events from older streams can't be mistaken for current ones.
   * The controller opens exactly one generation per value.
   */
  readonly attempt: number;
  /** How long the controller waits before opening `attempt`. */
  readonly openDelayMs: number;
  /** The attempt whose audio is playing. */
  readonly liveAttempt: number | null;
  /** The server's generation number from the latest answer. */
  readonly generation: number | null;
  readonly sessionThreadId: ThreadId | null;
  /** Consecutive lost generations since the last answer. */
  readonly failures: number;
  readonly muted: boolean;
  /** The assistant's current spoken line. `done` once the turn finishes. */
  readonly transcript: { readonly text: string; readonly done: boolean } | null;
  /** Newest first. */
  readonly notices: ReadonlyArray<VoiceNotice>;
  /** The live generation sent a snapshot, so individual attention notices are stale. */
  readonly hasRequestSnapshot: boolean;
  readonly confirms: ReadonlyArray<VoiceConfirmRequest>;
  readonly message: string | null;
}

export type VoiceSessionAction =
  | {
      readonly type: "start";
      readonly at: number;
      readonly environmentId: EnvironmentId;
      readonly focusThreadId: ThreadId | null;
    }
  | { readonly type: "hang-up"; readonly at: number }
  | {
      readonly type: "startup";
      readonly attempt: number;
      readonly stage: VoiceStartupStage;
      readonly at: number;
    }
  | {
      readonly type: "server";
      readonly attempt: number;
      readonly event: VoiceSessionEvent;
      readonly at: number;
    }
  /**
   * A generation died without an `ended` event: its stream completed or
   * failed, its peer could not be set up, or its audio connection failed.
   */
  | {
      readonly type: "generation-lost";
      readonly attempt: number;
      readonly message: string | null;
      readonly at: number;
    }
  /** A generation's audio actually connected; only this clears the failure count. */
  | { readonly type: "audio-connected"; readonly attempt: number; readonly at: number }
  | { readonly type: "microphone-denied"; readonly attempt: number; readonly at: number }
  | { readonly type: "toggle-mute" }
  /** A parsed JSON event from a generation's `oai-events` data channel. */
  | { readonly type: "realtime"; readonly attempt: number; readonly event: unknown }
  /** The confirm card expired or the user already answered it. */
  | { readonly type: "confirm-removed"; readonly requestId: string };

/** Waits before each reconnect. One more failure than this gives up. */
export const RECONNECT_DELAYS_MS: ReadonlyArray<number> = [1_000, 3_000, 8_000];

const MAX_NOTICES = 20;

function isRequestNotice(notice: VoiceNotice): boolean {
  return notice.kind === "input" || notice.kind === "approval";
}

function newestNotices(notices: ReadonlyArray<VoiceNotice>): ReadonlyArray<VoiceNotice> {
  return [...notices]
    .sort((a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt))
    .slice(0, MAX_NOTICES);
}

export const INITIAL_VOICE_SESSION_STATE: VoiceSessionState = {
  status: "idle",
  startupLog: [],
  environmentId: null,
  focusThreadId: null,
  attempt: 0,
  openDelayMs: 0,
  liveAttempt: null,
  generation: null,
  sessionThreadId: null,
  failures: 0,
  muted: false,
  transcript: null,
  notices: [],
  hasRequestSnapshot: false,
  confirms: [],
  message: null,
};

/** True while the phone holds the mic or is trying to get a generation going. */
export function isVoiceSessionActive(state: VoiceSessionState): boolean {
  return (
    state.status === "connecting" || state.status === "live" || state.status === "reconnecting"
  );
}

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

/**
 * Handles the loss of `attempt`. Losing the newest attempt reconnects with
 * backoff, or gives up after `RECONNECT_DELAYS_MS.length` tries. Losing an
 * older live generation while a newer one is opening only drops its audio.
 */
function logStartup(
  state: VoiceSessionState,
  stage: VoiceStartupStage,
  at: number,
): VoiceSessionState {
  if (
    state.startupLog.at(-1)?.stage === stage &&
    state.startupLog.at(-1)?.attempt === state.attempt
  )
    return state;
  return {
    ...state,
    startupLog: [...state.startupLog, { stage, at, attempt: state.attempt }].slice(-24),
  };
}

function loseGeneration(
  state: VoiceSessionState,
  attempt: number,
  message: string | null,
  at: number,
): VoiceSessionState {
  if (attempt !== state.attempt) {
    return attempt === state.liveAttempt
      ? { ...state, status: "reconnecting", liveAttempt: null, transcript: null }
      : state;
  }
  const failures = state.failures + 1;
  const delay = RECONNECT_DELAYS_MS[failures - 1];
  if (delay === undefined) {
    return {
      ...logStartup(state, "failed", at),
      status: "failed",
      liveAttempt: null,
      confirms: [],
      message: message ?? "The voice session dropped and could not reconnect.",
    };
  }
  // A failed rotation leaves the previous generation playing.
  const stillLive = state.liveAttempt !== null && state.liveAttempt !== attempt;
  return {
    ...logStartup(state, "retrying", at),
    status: stillLive ? "live" : state.generation === null ? "connecting" : "reconnecting",
    liveAttempt: stillLive ? state.liveAttempt : null,
    attempt: state.attempt + 1,
    openDelayMs: delay,
    failures,
    message,
  };
}

function applyEnded(
  state: VoiceSessionState,
  attempt: number,
  reason: VoiceSessionEndReason,
  message: string | null,
  at: number,
): VoiceSessionState {
  switch (reason) {
    case "rotated":
      // Expected on the generation our own newer open replaced. On the newest
      // one it means another client opened the session.
      if (attempt !== state.attempt) return state;
      return {
        ...state,
        status: "ended",
        liveAttempt: null,
        confirms: [],
        message: message ?? "The session moved to another device.",
      };
    case "hung_up":
      if (attempt !== state.attempt && attempt !== state.liveAttempt) return state;
      return { ...state, status: "ended", liveAttempt: null, confirms: [], message };
    case "closed":
    case "error":
      return loseGeneration(state, attempt, message, at);
  }
}

function applyServerEvent(
  state: VoiceSessionState,
  attempt: number,
  event: VoiceSessionEvent,
  at: number,
): VoiceSessionState {
  switch (event.type) {
    case "answer":
      if (attempt !== state.attempt) return state;
      return {
        ...state,
        liveAttempt: attempt,
        generation: event.generation,
        sessionThreadId: event.sessionThreadId,
        focusThreadId: null,
        hasRequestSnapshot: false,
        message: null,
      };
    case "startup":
      return attempt === state.attempt ? logStartup(state, event.stage, at) : state;
    case "rotate":
      // Ignore a repeat while the next generation is already opening.
      if (attempt !== state.liveAttempt || state.attempt !== attempt) return state;
      return { ...state, attempt: state.attempt + 1, openDelayMs: 0 };
    case "ended":
      return applyEnded(state, attempt, event.reason, event.message ?? null, at);
    case "request_notices":
      if (attempt !== state.liveAttempt) return state;
      return {
        ...state,
        hasRequestSnapshot: true,
        notices: newestNotices([
          ...event.notices.filter(isRequestNotice),
          ...state.notices.filter((notice) => !isRequestNotice(notice)),
        ]),
      };
    case "notice":
      if (attempt !== state.liveAttempt) return state;
      // Older servers send individual pending cards. Once a snapshot arrives, it owns them.
      if (state.hasRequestSnapshot && isRequestNotice(event.notice)) return state;
      if (state.notices.some((notice) => notice.id === event.notice.id)) return state;
      return { ...state, notices: newestNotices([event.notice, ...state.notices]) };
    case "confirm":
      if (state.confirms.some((request) => request.id === event.request.id)) return state;
      return { ...state, confirms: [...state.confirms, event.request] };
    case "confirm_resolved":
      return removeConfirm(state, event.requestId);
  }
}

function removeConfirm(state: VoiceSessionState, requestId: string): VoiceSessionState {
  const confirms = state.confirms.filter((request) => request.id !== requestId);
  return confirms.length === state.confirms.length ? state : { ...state, confirms };
}

/**
 * Pure transitions for the orchestrator session. The controller runs the side
 * effects by comparing states: a new `attempt` opens a generation, and any
 * generation that is neither `attempt` nor `liveAttempt` gets closed.
 */
export function voiceSessionReducer(
  state: VoiceSessionState,
  action: VoiceSessionAction,
): VoiceSessionState {
  switch (action.type) {
    case "start":
      // A live session only gets focused, never restarted.
      if (isVoiceSessionActive(state)) return state;
      return {
        ...INITIAL_VOICE_SESSION_STATE,
        startupLog: [{ stage: "microphone", at: action.at, attempt: state.attempt + 1 }],
        status: "connecting",
        environmentId: action.environmentId,
        focusThreadId: action.focusThreadId,
        attempt: state.attempt + 1,
      };
    case "hang-up":
      if (!isVoiceSessionActive(state)) return state;
      return {
        ...logStartup(state, "cancelled", action.at),
        status: "ended",
        liveAttempt: null,
        confirms: [],
        message: null,
      };
    case "microphone-denied":
      if (action.attempt !== state.attempt || !isVoiceSessionActive(state)) return state;
      return {
        ...logStartup(state, "microphone-denied", action.at),
        status: "microphone-denied",
        liveAttempt: null,
        confirms: [],
      };
    case "server":
      if (!isVoiceSessionActive(state)) return state;
      return applyServerEvent(state, action.attempt, action.event, action.at);
    case "audio-connected":
      if (!isVoiceSessionActive(state) || action.attempt !== state.liveAttempt) return state;
      return { ...logStartup(state, "connected", action.at), status: "live", failures: 0 };
    case "generation-lost":
      if (!isVoiceSessionActive(state)) return state;
      return loseGeneration(state, action.attempt, action.message, action.at);
    case "startup":
      return isVoiceSessionActive(state) && action.attempt === state.attempt
        ? logStartup(state, action.stage, action.at)
        : state;
    case "toggle-mute":
      return isVoiceSessionActive(state) ? { ...state, muted: !state.muted } : state;
    case "confirm-removed":
      return removeConfirm(state, action.requestId);
    case "realtime": {
      if (action.attempt !== state.liveAttempt) return state;
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
