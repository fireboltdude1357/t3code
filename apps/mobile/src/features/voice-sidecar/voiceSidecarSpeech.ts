import { useCallback, useEffect, useRef, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
import type { LunaHostClient, LunaMessage } from "./lunaHostApi";

export interface VoiceSidecarSpeechState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly uri: string | null;
  readonly error: string | null;
  readonly shouldAutoPlay: boolean;
}

const IDLE_SPEECH: VoiceSidecarSpeechState = {
  status: "idle",
  uri: null,
  error: null,
  shouldAutoPlay: false,
};

export function voiceSpeechFileExtension(mimeType: string): string {
  switch (mimeType.split(";", 1)[0]?.trim().toLowerCase()) {
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "webm";
    case "audio/flac":
      return "flac";
    default:
      return "audio";
  }
}

async function removeCachedSpeech(uri: string): Promise<void> {
  try {
    const { File } = await import("expo-file-system");
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (error) {
    console.warn("[voice-sidecar] could not remove cached speech", error);
  }
}

async function cacheSpeech(bytes: Uint8Array, mimeType: string): Promise<string> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.cache, "voice-sidecar-speech");
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, `luna-${uuidv4()}.${voiceSpeechFileExtension(mimeType)}`);
  file.create({ overwrite: true });
  file.write(bytes);
  return file.uri;
}

function completedAssistantMessageIds(messages: ReadonlyArray<LunaMessage>): ReadonlyArray<string> {
  return messages.flatMap((message) =>
    message.role === "assistant" && message.status === "complete" ? [message.id] : [],
  );
}

/**
 * Downloads Luna speech from the voice host (which synthesizes through Kokoro
 * on first request), caches it locally, and auto-plays newly arrived answers.
 */
export function useVoiceSidecarSpeech(input: {
  readonly client: LunaHostClient | null;
  readonly sessionId: string | null;
  readonly messages: ReadonlyArray<LunaMessage>;
  readonly enabled: boolean;
}) {
  const [speechByMessageId, setSpeechByMessageId] = useState<
    Readonly<Record<string, VoiceSidecarSpeechState>>
  >({});
  const stateRef = useRef(speechByMessageId);
  const cachedFilesRef = useRef(new Map<string, string>());
  const requestsRef = useRef(new Map<string, AbortController>());
  const observedCompleteIdsRef = useRef(new Set<string>());
  const initializedSessionRef = useRef<string | null>(null);
  const activeSessionRef = useRef<string | null>(null);

  useEffect(() => {
    stateRef.current = speechByMessageId;
  }, [speechByMessageId]);

  const updateSpeech = useCallback(
    (messageId: string, update: (current: VoiceSidecarSpeechState) => VoiceSidecarSpeechState) => {
      setSpeechByMessageId((current) => {
        const next = {
          ...current,
          [messageId]: update(current[messageId] ?? IDLE_SPEECH),
        };
        stateRef.current = next;
        return next;
      });
    },
    [],
  );

  const requestSpeech = useCallback(
    async (messageId: string, autoPlay = true): Promise<void> => {
      if (!input.enabled || input.sessionId === null || input.client === null) return;
      const current = stateRef.current[messageId];
      if (current?.status === "loading") return;
      if (current?.status === "ready" && current.uri) {
        updateSpeech(messageId, (value) => ({ ...value, shouldAutoPlay: autoPlay }));
        return;
      }

      requestsRef.current.get(messageId)?.abort();
      const controller = new AbortController();
      requestsRef.current.set(messageId, controller);
      updateSpeech(messageId, () => ({
        status: "loading",
        uri: null,
        error: null,
        shouldAutoPlay: false,
      }));

      try {
        const audio = await input.client.fetchSpeech(input.sessionId, messageId, controller.signal);
        if (controller.signal.aborted) return;
        const uri = await cacheSpeech(audio.bytes, audio.mimeType);
        if (controller.signal.aborted) {
          await removeCachedSpeech(uri);
          return;
        }
        const previousUri = cachedFilesRef.current.get(messageId);
        cachedFilesRef.current.set(messageId, uri);
        if (previousUri && previousUri !== uri) void removeCachedSpeech(previousUri);
        updateSpeech(messageId, () => ({
          status: "ready",
          uri,
          error: null,
          shouldAutoPlay: autoPlay,
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        updateSpeech(messageId, () => ({
          status: "error",
          uri: null,
          error:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Could not prepare Luna audio.",
          shouldAutoPlay: false,
        }));
      } finally {
        if (requestsRef.current.get(messageId) === controller) {
          requestsRef.current.delete(messageId);
        }
      }
    },
    [input.client, input.enabled, input.sessionId, updateSpeech],
  );

  const consumeAutoPlay = useCallback(
    (messageId: string) => {
      updateSpeech(messageId, (current) => ({ ...current, shouldAutoPlay: false }));
    },
    [updateSpeech],
  );

  useEffect(() => {
    if (activeSessionRef.current === input.sessionId) return;
    for (const request of requestsRef.current.values()) request.abort();
    requestsRef.current.clear();
    for (const uri of cachedFilesRef.current.values()) void removeCachedSpeech(uri);
    cachedFilesRef.current.clear();
    observedCompleteIdsRef.current.clear();
    initializedSessionRef.current = null;
    activeSessionRef.current = input.sessionId;
    setSpeechByMessageId({});
    stateRef.current = {};
  }, [input.sessionId]);

  useEffect(() => {
    if (!input.enabled || input.sessionId === null || input.client === null) return;
    const completeIds = completedAssistantMessageIds(input.messages);
    if (initializedSessionRef.current !== input.sessionId) {
      initializedSessionRef.current = input.sessionId;
      observedCompleteIdsRef.current = new Set(completeIds);
      const latestId = completeIds.at(-1);
      if (latestId) void requestSpeech(latestId, true);
      return;
    }

    for (const messageId of completeIds) {
      if (observedCompleteIdsRef.current.has(messageId)) continue;
      observedCompleteIdsRef.current.add(messageId);
      void requestSpeech(messageId, true);
    }
  }, [input.client, input.enabled, input.messages, input.sessionId, requestSpeech]);

  useEffect(() => {
    return () => {
      for (const request of requestsRef.current.values()) request.abort();
      requestsRef.current.clear();
      for (const uri of cachedFilesRef.current.values()) void removeCachedSpeech(uri);
      cachedFilesRef.current.clear();
    };
  }, []);

  return {
    speechByMessageId,
    requestSpeech,
    consumeAutoPlay,
  };
}
