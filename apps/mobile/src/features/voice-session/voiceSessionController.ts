import { useAtomValue } from "@effect/atom-react";
import { runStream } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  runStreamInEnvironment,
} from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type ThreadId,
  type VoiceSessionEvent,
  type VoiceSessionOpenInput,
} from "@t3tools/contracts";
import { requestRecordingPermissionsAsync } from "expo-audio";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { AppState, type NativeEventSubscription } from "react-native";
import InCallManager from "react-native-incall-manager";

import { mobilePreferencesAtom } from "../../state/preferences";
import { createVoiceStartupAudio } from "./voiceStartupAudio";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { openVoiceSessionPeer, type VoiceSessionPeer } from "./voiceSessionPeer";
import {
  INITIAL_VOICE_SESSION_STATE,
  isVoiceSessionActive,
  voiceSessionReducer,
  type VoiceSessionAction,
  type VoiceSessionState,
  type VoiceStartupStage,
} from "./voiceSessionState";

/**
 * The one orchestrator session on this phone. It lives in the app's atom
 * registry rather than in a screen, so the call keeps going while the user
 * moves between threads. Screens read it with `useVoiceSession`.
 */
export const voiceSessionStateAtom = Atom.make(INITIAL_VOICE_SESSION_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:voice-session:state"),
);

/** Answers a confirm card. `accepted` is false when it already expired or was answered. */
export const voiceSessionRespondCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:voice-session:respond",
  tag: WS_METHODS.voiceSessionRespond,
});

/**
 * One generation's stream. `Stream.chunks` makes every emission a whole
 * chunk, because a stream atom only keeps the last element of each chunk and
 * a batch of notices must not lose any.
 */
function openStreamAtom(environmentId: EnvironmentId, input: VoiceSessionOpenInput) {
  return connectionAtomRuntime
    .atom(
      runStreamInEnvironment(
        environmentId,
        runStream(WS_METHODS.voiceSessionOpen, input).pipe(Stream.chunks),
      ),
    )
    .pipe(Atom.setIdleTTL(0), Atom.withLabel("mobile:voice-session:open"));
}

/** Covers the server's setup turn and realtime handshake with room to spare. */
const ANSWER_TIMEOUT_MS = 45_000;

interface Generation {
  readonly attempt: number;
  peer: VoiceSessionPeer | null;
  /** Unsubscribing drops the stream atom, which is how the server learns this generation hung up. */
  unsubscribe: (() => void) | null;
  openTimer: ReturnType<typeof setTimeout> | null;
  /** Gives up on a stream that never answers, e.g. while the environment is unreachable. */
  answerTimer: ReturnType<typeof setTimeout> | null;
  lastBatch: ReadonlyArray<VoiceSessionEvent> | null;
  /** Set once the server sent `ended`, so the stream finishing isn't a second loss. */
  ended: boolean;
  closed: boolean;
}

const voiceStartupAudio = createVoiceStartupAudio();
const generations = new Map<number, Generation>();
const confirmTimers = new Map<string, ReturnType<typeof setTimeout>>();
let preferencesSubscription: (() => void) | null = null;
let appStateSubscription: NativeEventSubscription | null = null;
let pendingActions: Array<VoiceSessionAction> = [];
let dispatching = false;

function startup(attempt: number, stage: VoiceStartupStage): void {
  dispatch({ type: "startup", attempt, stage, at: Date.now() });
}

function syncStartupAudio(): void {
  const state = readState();
  const stage = state.startupLog.at(-1)?.stage;
  const waiting =
    (state.status === "connecting" || state.status === "reconnecting") &&
    stage !== "retrying" &&
    stage !== "connecting-audio";
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  if (waiting && preferences._tag === "Success") {
    voiceStartupAudio.start(preferences.value.voiceStartupAudio ?? "ringing");
  } else {
    voiceStartupAudio.stop();
  }
}

function readState(): VoiceSessionState {
  return appAtomRegistry.get(voiceSessionStateAtom);
}

/** Applies actions in order. Effects may dispatch again; those queue behind the current one. */
function dispatch(action: VoiceSessionAction): void {
  pendingActions.push(action);
  if (dispatching) return;
  dispatching = true;
  try {
    while (pendingActions.length > 0) {
      const [next, ...rest] = pendingActions;
      pendingActions = rest;
      if (next === undefined) break;
      const previous = readState();
      const state = voiceSessionReducer(previous, next);
      if (state === previous) continue;
      appAtomRegistry.set(voiceSessionStateAtom, state);
      runEffects(previous, state);
    }
  } finally {
    dispatching = false;
  }
}

function closeGeneration(generation: Generation): void {
  generation.closed = true;
  if (generation.openTimer !== null) clearTimeout(generation.openTimer);
  if (generation.answerTimer !== null) clearTimeout(generation.answerTimer);
  generation.unsubscribe?.();
  generation.peer?.close();
  generations.delete(generation.attempt);
}

function lose(attempt: number, message: string | null): void {
  voiceStartupAudio.stop();
  dispatch({ type: "generation-lost", attempt, message, at: Date.now() });
}

function handleStreamResult(
  generation: Generation,
  result: AsyncResult.AsyncResult<ReadonlyArray<VoiceSessionEvent>, unknown>,
): void {
  if (generation.closed) return;
  const { attempt } = generation;
  if (result._tag === "Failure") {
    if (!generation.ended) {
      lose(attempt, "The voice session connection failed.");
    }
    return;
  }
  if (result._tag !== "Success") return;
  if (result.value !== generation.lastBatch) {
    generation.lastBatch = result.value;
    for (const event of result.value) {
      if (generation.closed) return;
      if (event.type === "answer") {
        startup(attempt, "connecting-audio");
        voiceStartupAudio.stop();
        dispatch({ type: "server", attempt, event, at: Date.now() });
        generation.peer?.acceptAnswer(event.sdpAnswer).catch(() => {
          if (!generation.closed) lose(attempt, "Could not connect the call audio.");
        });
        continue;
      }
      if (event.type === "ended") {
        generation.ended = true;
        voiceStartupAudio.stop();
      }
      dispatch({
        type: "server",
        attempt,
        event:
          event.type === "ended" && event.reason === "error"
            ? {
                type: "ended",
                reason: "error",
                message: "The server could not start or keep the call connected.",
              }
            : event,
        at: Date.now(),
      });
    }
  }
  if (!result.waiting && !generation.ended && !generation.closed) lose(attempt, null);
}

async function runGeneration(
  generation: Generation,
  environmentId: EnvironmentId,
  focusThreadId: ThreadId | null,
): Promise<void> {
  const { attempt } = generation;
  startup(attempt, "microphone");
  const permission = await requestRecordingPermissionsAsync();
  if (generation.closed) return;
  if (!permission.granted) {
    dispatch({ type: "microphone-denied", attempt, at: Date.now() });
    return;
  }
  startup(attempt, "preparing-audio");
  generation.answerTimer = setTimeout(() => {
    generation.answerTimer = null;
    lose(attempt, "The call did not connect in time.");
  }, ANSWER_TIMEOUT_MS);
  const peer = await openVoiceSessionPeer({
    onRealtimeEvent: (event) => dispatch({ type: "realtime", attempt, event }),
    onConnectionFailed: () => {
      if (!generation.closed) lose(attempt, "The call audio connection dropped.");
    },
    onConnected: () => {
      if (generation.closed) return;
      voiceStartupAudio.stop();
      if (generation.answerTimer !== null) clearTimeout(generation.answerTimer);
      generation.answerTimer = null;
      dispatch({ type: "audio-connected", attempt, at: Date.now() });
    },
  });
  if (generation.closed) {
    peer.close();
    return;
  }
  generation.peer = peer;
  peer.setMuted(readState().muted);
  startup(attempt, "contacting-server");
  const atom = openStreamAtom(environmentId, {
    sdpOffer: peer.offerSdp,
    startupProgress: true,
    ...(focusThreadId === null ? {} : { focusThreadId }),
  });
  const unsubscribe = appAtomRegistry.subscribe(
    atom,
    (result) => handleStreamResult(generation, result),
    { immediate: true },
  );
  // The immediate callback can already have closed this generation.
  if (generation.closed) {
    unsubscribe();
    return;
  }
  generation.unsubscribe = unsubscribe;
}

function openGeneration(state: VoiceSessionState): void {
  const { attempt, environmentId, focusThreadId } = state;
  if (environmentId === null) return;
  const generation: Generation = {
    attempt,
    peer: null,
    unsubscribe: null,
    openTimer: null,
    answerTimer: null,
    lastBatch: null,
    ended: false,
    closed: false,
  };
  generations.set(attempt, generation);
  generation.openTimer = setTimeout(() => {
    generation.openTimer = null;
    runGeneration(generation, environmentId, focusThreadId).catch(() => {
      if (!generation.closed) lose(attempt, "Could not start the microphone.");
    });
  }, state.openDelayMs);
}

/** Opens a new generation when the app comes back with a dead connection. */
function checkLiveConnection(): void {
  const state = readState();
  if (state.liveAttempt === null) return;
  const peer = generations.get(state.liveAttempt)?.peer;
  if (peer !== undefined && peer !== null && !peer.isConnected()) {
    lose(state.liveAttempt, "The call audio connection dropped.");
  }
}

function syncConfirmTimers(state: VoiceSessionState): void {
  const ids = new Set(state.confirms.map((request) => request.id));
  for (const [id, timer] of confirmTimers) {
    if (ids.has(id)) continue;
    clearTimeout(timer);
    confirmTimers.delete(id);
  }
  for (const request of state.confirms) {
    if (confirmTimers.has(request.id)) continue;
    const delay = Math.max(0, DateTime.toEpochMillis(request.expiresAt) - Date.now());
    confirmTimers.set(
      request.id,
      setTimeout(() => {
        confirmTimers.delete(request.id);
        dispatch({ type: "confirm-removed", requestId: request.id });
      }, delay),
    );
  }
}

/** Brings the peers, streams, audio session and timers in line with the new state. */
function runEffects(previous: VoiceSessionState, state: VoiceSessionState): void {
  const active = isVoiceSessionActive(state);
  const wasActive = isVoiceSessionActive(previous);

  if (active && !wasActive) {
    // "video" media selects the speaker by default while still yielding to
    // headphones and Bluetooth; "audio" would route the reply to the earpiece.
    InCallManager.start({ media: "video" });
    preferencesSubscription = appAtomRegistry.subscribe(
      mobilePreferencesAtom,
      () => syncStartupAudio(),
      { immediate: true },
    );

    appStateSubscription = AppState.addEventListener("change", (next) => {
      if (next === "active") checkLiveConnection();
    });
  }

  syncStartupAudio();

  // Keep only the newest attempt and the one playing audio.
  // Deleting the current entry while iterating a Map is safe.
  for (const generation of generations.values()) {
    const keep =
      active && (generation.attempt === state.attempt || generation.attempt === state.liveAttempt);
    if (!keep) closeGeneration(generation);
  }
  if (active && state.attempt !== previous.attempt && !generations.has(state.attempt)) {
    openGeneration(state);
  }

  if (state.muted !== previous.muted) {
    for (const generation of generations.values()) generation.peer?.setMuted(state.muted);
  }
  if (state.confirms !== previous.confirms) syncConfirmTimers(state);

  if (!active && wasActive) {
    preferencesSubscription?.();
    preferencesSubscription = null;
    voiceStartupAudio.stop();
    appStateSubscription?.remove();
    appStateSubscription = null;
    InCallManager.stop();
  }
}

/**
 * Starts the orchestrator in `environmentId`, briefed on `focusThreadId`
 * first. Does nothing while a session is already running.
 */
export function startVoiceSession(input: {
  readonly environmentId: EnvironmentId;
  readonly focusThreadId: ThreadId | null;
}): void {
  dispatch({ type: "start", ...input, at: Date.now() });
}

export function hangUpVoiceSession(): void {
  voiceStartupAudio.stop();
  dispatch({ type: "hang-up", at: Date.now() });
}

export function toggleVoiceSessionMute(): void {
  dispatch({ type: "toggle-mute" });
}

/** Drops a confirm card after the user answered it. */
export function removeVoiceSessionConfirm(requestId: string): void {
  dispatch({ type: "confirm-removed", requestId });
}

/** The orchestrator session state, for the mini-bar, sheet and entry points. */
export function useVoiceSession(): VoiceSessionState {
  return useAtomValue(voiceSessionStateAtom);
}
