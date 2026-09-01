import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import type { VoiceSidecarRecordingCapture } from "./lunaHostApi";
import { ignoreReleasedNativeObject } from "./releasedNativeObject";

const MAX_RECORDING_SECONDS = 5 * 60;
const RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

type RecorderState =
  | { readonly phase: "idle"; readonly error: null }
  | { readonly phase: "preparing"; readonly error: null }
  | { readonly phase: "recording"; readonly error: null }
  | { readonly phase: "submitting"; readonly error: null }
  | { readonly phase: "error"; readonly error: string };

type RecorderStatusEvent = Pick<
  RecordingStatus,
  "error" | "hasError" | "isFinished" | "mediaServicesDidReset" | "url"
>;

function interruptionMessage(status: RecorderStatusEvent): string | null {
  if (status.hasError || status.mediaServicesDidReset === true) {
    return status.error ?? "Voice recording was interrupted.";
  }
  if (status.isFinished) return "Voice recording ended unexpectedly.";
  return null;
}

export async function discardInterruptedVoiceSidecarRecording(input: {
  readonly status: RecorderStatusEvent;
  readonly recordingUris: ReadonlyArray<string | null>;
  readonly stop: () => Promise<void>;
  readonly remove: (uri: string | null) => void;
  readonly release: () => Promise<void>;
}): Promise<string | null> {
  const message = interruptionMessage(input.status);
  if (!message) return null;

  try {
    if (!input.status.isFinished) await input.stop();
  } catch {
    // An interrupted recorder may already be invalid. Cleanup still has to run.
  } finally {
    for (const uri of new Set([input.status.url, ...input.recordingUris])) {
      input.remove(uri);
    }
    await input.release();
  }

  return message;
}

async function activateRecordingSession(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: true,
    interruptionMode: "doNotMix",
    playsInSilentMode: true,
    shouldPlayInBackground: false,
  });
  await setIsAudioActiveAsync(true);
}

async function releaseRecordingSession(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    await setIsAudioActiveAsync(false);
  }
}

function removeRecording(uri: string | null): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (error) {
    console.warn("[voice-sidecar] could not remove a local recording", error);
  }
}

function captureFromUri(uri: string): VoiceSidecarRecordingCapture {
  const file = new File(uri);
  const sizeBytes = file.size;
  if (!file.exists || sizeBytes === null || sizeBytes <= 0) {
    throw new Error("The voice recording was empty.");
  }
  return {
    uri,
    name: `voice-${Date.now()}.m4a`,
    mimeType: "audio/mp4",
    sizeBytes,
  };
}

export function useVoiceSidecarRecorder(input: {
  readonly disabled?: boolean;
  readonly onCapture: (capture: VoiceSidecarRecordingCapture) => Promise<void>;
}) {
  const [state, setState] = useState<RecorderState>({ phase: "idle", error: null });
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const activeRef = useRef(true);
  const stateRef = useRef<RecorderState>(state);
  const recordingUriRef = useRef<string | null>(null);
  const operationRef = useRef(0);
  const recordingSessionActiveRef = useRef(false);
  const interruptionInFlightRef = useRef(false);
  const interruptionHandlerRef = useRef<(status: RecordingStatus) => void>(() => undefined);
  const latestInputRef = useRef(input);
  latestInputRef.current = input;

  const transition = useCallback((next: RecorderState) => {
    stateRef.current = next;
    if (activeRef.current) setState(next);
  }, []);

  const handleRecorderStatus = useCallback((status: RecordingStatus) => {
    interruptionHandlerRef.current(status);
  }, []);
  const recorder = useAudioRecorder(RECORDING_OPTIONS, handleRecorderStatus);

  const releaseSession = useCallback(async () => {
    if (!recordingSessionActiveRef.current) return;
    recordingSessionActiveRef.current = false;
    try {
      await releaseRecordingSession();
    } catch (error) {
      console.warn("[voice-sidecar] could not release the recording session", error);
    }
  }, []);

  const interruptRecording = useCallback(
    (status: RecordingStatus) => {
      if (stateRef.current.phase !== "recording" || interruptionInFlightRef.current) return;
      const message = interruptionMessage(status);
      if (!message) return;

      interruptionInFlightRef.current = true;
      operationRef.current += 1;
      transition({ phase: "error", error: message });
      setElapsedSeconds(0);

      const recordingUri = recordingUriRef.current;
      recordingUriRef.current = null;
      void discardInterruptedVoiceSidecarRecording({
        status,
        recordingUris: [recordingUri, ignoreReleasedNativeObject(() => recorder.uri) ?? null],
        stop: async () => {
          if (recorder.getStatus().isRecording) await recorder.stop();
        },
        remove: removeRecording,
        release: releaseSession,
      }).finally(() => {
        interruptionInFlightRef.current = false;
      });
    },
    [recorder, releaseSession, transition],
  );
  interruptionHandlerRef.current = interruptRecording;

  const cancel = useCallback(async () => {
    operationRef.current += 1;
    transition({ phase: "idle", error: null });
    setElapsedSeconds(0);
    try {
      if (recorder.getStatus().isRecording) await recorder.stop();
    } catch {
      // Recorder teardown is best-effort. The local file is still removed below.
    }
    // On unmount the hook's recorder is already released; an unguarded native
    // read here would reject and skip the session release below.
    const uri = ignoreReleasedNativeObject(() => recorder.uri) ?? recordingUriRef.current;
    recordingUriRef.current = null;
    removeRecording(uri);
    await releaseSession();
  }, [recorder, releaseSession, transition]);

  const start = useCallback(async () => {
    if (latestInputRef.current.disabled) return;
    if (stateRef.current.phase !== "idle" && stateRef.current.phase !== "error") return;
    const operation = ++operationRef.current;
    transition({ phase: "preparing", error: null });
    setElapsedSeconds(0);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (operation !== operationRef.current) return;
      if (!permission.granted) {
        transition({ phase: "error", error: "Microphone access is required." });
        return;
      }
      await activateRecordingSession();
      recordingSessionActiveRef.current = true;
      if (operation !== operationRef.current) {
        await releaseSession();
        return;
      }
      await recorder.prepareToRecordAsync();
      recordingUriRef.current = recorder.uri;
      recorder.record();
      transition({ phase: "recording", error: null });
    } catch (error) {
      await releaseSession();
      if (operation === operationRef.current && activeRef.current) {
        transition({
          phase: "error",
          error: error instanceof Error ? error.message : "Could not start voice recording.",
        });
      }
    }
  }, [recorder, releaseSession, transition]);

  const stop = useCallback(async () => {
    if (stateRef.current.phase !== "recording") return;
    const operation = operationRef.current;
    transition({ phase: "submitting", error: null });
    let uri: string | null = null;
    try {
      await recorder.stop();
      await releaseSession();
      uri = recorder.uri ?? recordingUriRef.current;
      if (!uri) throw new Error("Could not finish voice recording.");
      const capture = captureFromUri(uri);
      await latestInputRef.current.onCapture(capture);
      if (operation === operationRef.current && activeRef.current) {
        transition({ phase: "idle", error: null });
        setElapsedSeconds(0);
      }
    } catch (error) {
      if (operation === operationRef.current && activeRef.current) {
        transition({
          phase: "error",
          error: error instanceof Error ? error.message : "Could not send the voice recording.",
        });
      }
    } finally {
      recordingUriRef.current = null;
      removeRecording(uri);
      await releaseSession();
    }
  }, [recorder, releaseSession, transition]);

  useEffect(() => {
    if (state.phase !== "recording") return;
    const sample = () => {
      const status = recorder.getStatus();
      if (!status.isRecording) return;
      const nextElapsed = Math.min(
        MAX_RECORDING_SECONDS,
        Math.floor(status.durationMillis / 1_000),
      );
      setElapsedSeconds(nextElapsed);
      if (nextElapsed >= MAX_RECORDING_SECONDS) void stop();
    };
    sample();
    const interval = setInterval(sample, 250);
    return () => clearInterval(interval);
  }, [recorder, state.phase, stop]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background" && (state.phase === "preparing" || state.phase === "recording")) {
        void cancel();
      }
    });
    return () => subscription.remove();
  }, [cancel, state.phase]);

  useFocusEffect(
    useCallback(
      () => () => {
        void cancel();
      },
      [cancel],
    ),
  );

  useEffect(
    () => () => {
      activeRef.current = false;
      void cancel();
    },
    [cancel],
  );

  const dismissError = useCallback(() => {
    transition({ phase: "idle", error: null });
  }, [transition]);

  return {
    state,
    elapsedSeconds,
    start,
    stop,
    cancel,
    dismissError,
  };
}
