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

/**
 * Downloaded speech and the answers already heard, per session, for the life
 * of the app run. Reopening the sidecar plays nothing on its own: only answers
 * that landed after the last look get auto-played, and everything already
 * downloaded is ready for replay without another round trip.
 */
interface SessionSpeechCache {
  readonly files: Map<string, string>;
  readonly heard: Set<string>;
}

const MAX_CACHED_SESSIONS = 4;
const speechCache = new Map<string, SessionSpeechCache>();
let speechDirectoryReady: Promise<void> | null = null;

async function removeCachedSpeech(uri: string): Promise<void> {
  try {
    const { File } = await import("expo-file-system");
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (error) {
    console.warn("[voice-sidecar] could not remove cached speech", error);
  }
}

/** Files from earlier app runs are unreachable from the in-memory cache, so start clean. */
async function speechDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.cache, "voice-sidecar-speech");
  speechDirectoryReady ??= (async () => {
    try {
      if (directory.exists) directory.delete();
    } catch (error) {
      console.warn("[voice-sidecar] could not clear stale speech", error);
    }
    directory.create({ idempotent: true, intermediates: true });
  })();
  await speechDirectoryReady;
  return directory;
}

async function cacheSpeech(bytes: Uint8Array, mimeType: string): Promise<string> {
  const { File } = await import("expo-file-system");
  const file = new File(
    await speechDirectory(),
    `luna-${uuidv4()}.${voiceSpeechFileExtension(mimeType)}`,
  );
  file.create({ overwrite: true });
  file.write(bytes);
  return file.uri;
}

function sessionCache(sessionId: string): SessionSpeechCache {
  const existing = speechCache.get(sessionId);
  if (existing) {
    speechCache.delete(sessionId);
    speechCache.set(sessionId, existing);
    return existing;
  }
  const created: SessionSpeechCache = { files: new Map(), heard: new Set() };
  speechCache.set(sessionId, created);
  while (speechCache.size > MAX_CACHED_SESSIONS) {
    const oldest = speechCache.keys().next().value;
    if (oldest === undefined) break;
    for (const uri of speechCache.get(oldest)?.files.values() ?? []) void removeCachedSpeech(uri);
    speechCache.delete(oldest);
  }
  return created;
}

function completedAssistantMessageIds(messages: ReadonlyArray<LunaMessage>): ReadonlyArray<string> {
  return messages.flatMap((message) =>
    message.role === "assistant" && message.status === "complete" ? [message.id] : [],
  );
}

/**
 * Downloads Luna speech from the voice host (which synthesizes through Kokoro
 * when the answer lands), keeps it in the per-session cache, and flags answers
 * that arrived since the last look for auto-play.
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
  const requestsRef = useRef(new Map<string, AbortController>());
  const initializedSessionRef = useRef<string | null>(null);

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
      const cache = sessionCache(input.sessionId);
      if (autoPlay) cache.heard.add(messageId);
      const current = stateRef.current[messageId];
      if (current?.status === "loading") {
        if (autoPlay) updateSpeech(messageId, (value) => ({ ...value, shouldAutoPlay: true }));
        return;
      }
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
        shouldAutoPlay: autoPlay,
      }));

      try {
        const audio = await input.client.fetchSpeech(input.sessionId, messageId, controller.signal);
        if (controller.signal.aborted) return;
        const uri = await cacheSpeech(audio.bytes, audio.mimeType);
        if (controller.signal.aborted) {
          await removeCachedSpeech(uri);
          return;
        }
        const previousUri = cache.files.get(messageId);
        cache.files.set(messageId, uri);
        if (previousUri && previousUri !== uri) void removeCachedSpeech(previousUri);
        updateSpeech(messageId, (value) => ({
          status: "ready",
          uri,
          error: null,
          // A replay asked for while loading still wins.
          shouldAutoPlay: value.shouldAutoPlay,
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
    if (!input.enabled || input.sessionId === null || input.client === null) return;
    const cache = sessionCache(input.sessionId);
    const completeIds = completedAssistantMessageIds(input.messages);
    if (initializedSessionRef.current !== input.sessionId) {
      initializedSessionRef.current = input.sessionId;
      for (const request of requestsRef.current.values()) request.abort();
      requestsRef.current.clear();
      // Restore what is already on disk so replay needs no network.
      const restored: Record<string, VoiceSidecarSpeechState> = {};
      for (const [messageId, uri] of cache.files) {
        restored[messageId] = { status: "ready", uri, error: null, shouldAutoPlay: false };
      }
      stateRef.current = restored;
      setSpeechByMessageId(restored);
      // First look at this session in this app run: nothing already here is
      // new, so mark it heard and just warm the latest answer for replay.
      if (cache.heard.size === 0 && cache.files.size === 0) {
        for (const messageId of completeIds) cache.heard.add(messageId);
        const latestId = completeIds.at(-1);
        if (latestId) void requestSpeech(latestId, false);
        return;
      }
    }

    for (const messageId of completeIds) {
      if (cache.heard.has(messageId)) continue;
      void requestSpeech(messageId, true);
    }
  }, [input.client, input.enabled, input.messages, input.sessionId, requestSpeech]);

  useEffect(() => {
    return () => {
      for (const request of requestsRef.current.values()) request.abort();
      requestsRef.current.clear();
    };
  }, []);

  return {
    speechByMessageId,
    requestSpeech,
    consumeAutoPlay,
  };
}
