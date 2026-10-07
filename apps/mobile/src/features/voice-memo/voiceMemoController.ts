import { useAtomValue } from "@effect/atom-react";
import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import {
  AudioModule,
  AudioQuality,
  createAudioPlayer,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  type AudioPlayer,
  type AudioRecorder,
} from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { voiceSessionStateAtom } from "../voice-session/voiceSessionController";
import { isVoiceSessionActive } from "../voice-session/voiceSessionState";
import { voiceSidecarUrl } from "../voice-session/voiceSidecar";
import {
  INITIAL_VOICE_MEMO_STATE,
  isVoiceMemoInFlight,
  VOICE_MEMO_MAX_RECORDING_MS,
  voiceMemoErrorMessage,
  voiceMemoReducer,
  type VoiceMemoAction,
  type VoiceMemoRecording,
  type VoiceMemoRequestError,
  type VoiceMemoStage,
  type VoiceMemoState,
} from "./voiceMemoState";
import {
  configureMemoPlaybackAudio,
  configureMemoRecordingAudio,
  releaseMemoRecordingAudio,
} from "./voiceMemoAudio";
import { downloadVoiceMemoReply, submitVoiceMemo } from "./voiceMemoTransport";

/**
 * The phone's one voice memo. It lives in the app's atom registry, so a memo
 * in flight survives the sheet closing and its reply still plays.
 */
export const voiceMemoStateAtom = Atom.make(INITIAL_VOICE_MEMO_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:voice-memo:state"),
);

/**
 * Mono AAC in an m4a file at 32 kbps, about 0.7 MB for the longest memo, so
 * uploads stay small on a weak signal. Already in the per-platform shape the
 * native recorder takes.
 */
const MEMO_RECORDER_OPTIONS = {
  extension: ".m4a",
  sampleRate: 22_050,
  numberOfChannels: 1,
  bitRate: 32_000,
  ...(Platform.OS === "ios"
    ? { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.MEDIUM }
    : { outputFormat: "mpeg4", audioEncoder: "aac" }),
};

let recorder: { readonly session: number; readonly instance: AudioRecorder } | null = null;
let autoSendTimer: ReturnType<typeof setTimeout> | null = null;
let transfer: AbortController | null = null;
let player: { readonly instance: AudioPlayer; readonly remove: () => void } | null = null;
let pendingActions: Array<VoiceMemoAction> = [];
let dispatching = false;

function readState(): VoiceMemoState {
  return appAtomRegistry.get(voiceMemoStateAtom);
}

/** Applies actions in order. Effects may dispatch again; those queue behind the current one. */
function dispatch(action: VoiceMemoAction): void {
  pendingActions.push(action);
  if (dispatching) return;
  dispatching = true;
  try {
    while (pendingActions.length > 0) {
      const [next, ...rest] = pendingActions;
      pendingActions = rest;
      if (next === undefined) break;
      const previous = readState();
      const state = voiceMemoReducer(previous, next);
      if (state === previous) continue;
      appAtomRegistry.set(voiceMemoStateAtom, state);
      runEffects(previous, state);
    }
  } finally {
    dispatching = false;
  }
}

function fail(session: number, stage: VoiceMemoStage, message: string): void {
  dispatch({ type: "failed", session, stage, message });
}

function deleteFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The cache directory gets cleared eventually anyway.
  }
}

function stillStarting(session: number): boolean {
  const state = readState();
  return state.session === session && state.status === "starting";
}

async function startRecorder(session: number): Promise<void> {
  const permission = await requestRecordingPermissionsAsync();
  if (!stillStarting(session)) return;
  if (!permission.granted) {
    dispatch({ type: "microphone-denied", session });
    return;
  }
  await configureMemoRecordingAudio();
  if (!stillStarting(session)) {
    await releaseMemoRecordingAudio();
    return;
  }
  const instance = new AudioModule.AudioRecorder(MEMO_RECORDER_OPTIONS);
  recorder = { session, instance };
  await instance.prepareToRecordAsync();
  // Cancelling while preparing already discarded this recorder.
  if (recorder?.instance !== instance) return;
  instance.record();
  dispatch({ type: "recording-started", session, at: Date.now() });
}

/** Stops the recorder and deletes what it wrote. */
function discardRecorder(): void {
  const current = recorder;
  recorder = null;
  if (current === null) return;
  void (async () => {
    try {
      await current.instance.stop();
    } finally {
      const uri = current.instance.uri;
      current.instance.release();
      if (uri !== null) deleteFile(uri);
      await releaseMemoRecordingAudio();
    }
  })().catch(() => {});
}

/** Stops the recorder and hands its file to the reducer as the new memo. */
async function finishRecorder(session: number): Promise<void> {
  const current = recorder;
  recorder = null;
  if (current === null || current.session !== session) {
    fail(session, "record", "The recording was lost.");
    return;
  }
  let uri: string | null = null;
  try {
    await current.instance.stop();
    uri = current.instance.uri;
  } finally {
    current.instance.release();
    await releaseMemoRecordingAudio().catch(() => {});
  }
  if (uri === null) {
    fail(session, "record", "The recording could not be saved.");
    return;
  }
  dispatch({
    type: "recorded",
    session,
    memo: { id: uuidv4(), fileUri: uri, focusThreadId: readState().focusThreadId },
  });
  // The memo was cancelled while the recorder stopped.
  if (readState().memo?.fileUri !== uri) deleteFile(uri);
}

/** Runs one network effect; leaving the in-flight statuses aborts it. */
async function runTransfer<A>(
  session: number,
  stage: VoiceMemoStage,
  effect: Effect.Effect<A, VoiceMemoRequestError>,
  onSuccess: (value: A) => void,
): Promise<void> {
  transfer?.abort();
  const controller = new AbortController();
  transfer = controller;
  const exit = await Effect.runPromiseExit(effect, { signal: controller.signal });
  if (transfer === controller) transfer = null;
  if (controller.signal.aborted) return;
  if (Exit.isSuccess(exit)) {
    onSuccess(exit.value);
    return;
  }
  const message = Option.match(Cause.findErrorOption(exit.cause), {
    onNone: () => "Something went wrong with the memo.",
    onSome: voiceMemoErrorMessage,
  });
  fail(session, stage, message);
}

function submit(baseUrl: string, session: number, memo: VoiceMemoRecording): void {
  void runTransfer(
    session,
    "submit",
    submitVoiceMemo({
      baseUrl,
      memo,
      readRecording: () => new File(memo.fileUri).bytes(),
      onUploaded: () => dispatch({ type: "uploaded", session }),
      onRetrying: () => dispatch({ type: "retrying", session }),
    }),
    (reply) => dispatch({ type: "reply-received", session, reply }),
  );
}

function download(baseUrl: string, state: VoiceMemoState): void {
  const { reply, session } = state;
  if (reply === null) return;
  const directory = new Directory(Paths.cache, "voice-memo");
  const file = new File(directory, `${reply.memoId}-reply.m4a`);
  void runTransfer(
    session,
    "download",
    downloadVoiceMemoReply({
      baseUrl,
      reply,
      save: async (bytes) => {
        directory.create({ idempotent: true, intermediates: true });
        file.create({ overwrite: true });
        await file.write(bytes);
      },
      onRetrying: () => dispatch({ type: "retrying", session }),
    }),
    () => dispatch({ type: "reply-downloaded", session, fileUri: file.uri }),
  );
}

function stopPlayer(): void {
  const current = player;
  player = null;
  if (current === null) return;
  current.remove();
  try {
    current.instance.pause();
    current.instance.remove();
    current.instance.release();
  } catch {
    // The native player may already be gone.
  }
}

async function startPlayer(session: number, playback: number, uri: string): Promise<void> {
  stopPlayer();
  await configureMemoPlaybackAudio();
  const state = readState();
  if (state.status !== "playing" || state.playback !== playback) return;
  const instance = createAudioPlayer(uri);
  const subscription = instance.addListener("playbackStatusUpdate", (status) => {
    if (status.didJustFinish) dispatch({ type: "playback-ended", session });
  });
  player = { instance, remove: () => subscription.remove() };
  instance.play();
}

/** Brings the recorder, network work, player and files in line with the new state. */
function runEffects(previous: VoiceMemoState, state: VoiceMemoState): void {
  const { session, status } = state;
  const wasRecording = previous.status === "starting" || previous.status === "recording";

  if (status === "starting" && (previous.status !== "starting" || previous.session !== session)) {
    startRecorder(session).catch(() => {
      discardRecorder();
      fail(session, "record", "Could not start the microphone.");
    });
  }
  if (status === "recording" && previous.status !== "recording") {
    autoSendTimer = setTimeout(sendVoiceMemoRecording, VOICE_MEMO_MAX_RECORDING_MS);
  }
  if (status !== "recording" && autoSendTimer !== null) {
    clearTimeout(autoSendTimer);
    autoSendTimer = null;
  }
  if (wasRecording && status === "sending") {
    finishRecorder(session).catch(() =>
      fail(session, "record", "The recording could not be saved."),
    );
  } else if (wasRecording && status !== "starting" && status !== "recording") {
    discardRecorder();
  }

  if (isVoiceMemoInFlight(previous) && !isVoiceMemoInFlight(state)) {
    transfer?.abort();
    transfer = null;
  }
  if (voiceSidecarUrl !== null) {
    if (
      status === "sending" &&
      state.memo !== null &&
      (previous.status !== "sending" || previous.memo !== state.memo)
    ) {
      submit(voiceSidecarUrl, session, state.memo);
    }
    if (status === "downloading" && previous.status !== "downloading") {
      download(voiceSidecarUrl, state);
    }
  }

  if (status === "playing" && state.playback !== previous.playback && state.replyFileUri !== null) {
    startPlayer(session, state.playback, state.replyFileUri).catch(() =>
      fail(session, "playback", "Could not play the reply."),
    );
  } else if (previous.status === "playing" && status !== "playing") {
    stopPlayer();
  }

  // Keep only the current memo's files, for Retry and Replay.
  if (previous.memo !== null && previous.memo.fileUri !== state.memo?.fileUri) {
    deleteFile(previous.memo.fileUri);
  }
  if (previous.replyFileUri !== null && previous.replyFileUri !== state.replyFileUri) {
    deleteFile(previous.replyFileUri);
  }
}

/** Shows the memo sheet's state for `focusThreadId`. A memo already in flight keeps going. */
export function openVoiceMemo(focusThreadId: ThreadId | null): void {
  dispatch({ type: "open", focusThreadId });
}

/** Starts recording, stopping a reply that is playing. */
export function startVoiceMemoRecording(): void {
  dispatch({ type: "record" });
}

export function sendVoiceMemoRecording(): void {
  dispatch({ type: "send" });
}

export function cancelVoiceMemoRecording(): void {
  dispatch({ type: "cancel-recording" });
}

/** Runs the failed step again with the same memo id and recording. */
export function retryVoiceMemo(): void {
  dispatch({ type: "retry" });
}

export function replayVoiceMemo(): void {
  dispatch({ type: "play" });
}

export function stopVoiceMemoPlayback(): void {
  dispatch({ type: "stop-playback" });
}

/** Drops the current memo and reply, abandoning any request still running. */
export function resetVoiceMemo(): void {
  dispatch({ type: "reset" });
}

export function closeVoiceMemoSheet(): void {
  dispatch({ type: "sheet-closed" });
}

export function useVoiceMemo(): VoiceMemoState {
  return useAtomValue(voiceMemoStateAtom);
}

/** Only flips when a call starts or ends, so screens skip the call's frequent updates. */
const voiceCallActiveAtom = Atom.make((get) => isVoiceSessionActive(get(voiceSessionStateAtom)));

/** Memos hide while a live call holds the microphone; the sidecar refuses them then anyway. */
export function useVoiceCallActive(): boolean {
  return useAtomValue(voiceCallActiveAtom);
}
