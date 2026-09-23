import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EnvironmentId, ThreadId, MessageId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { AppText as Text } from "../../components/AppText";
import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { useEnvironmentThread } from "../../state/threads";
import { useLunaHost } from "../../state/voice-sidecar-host";
import { uuidv4 } from "../../lib/uuid";
import {
  type LunaSessionPreferences,
  type LunaSnapshot,
  type VoiceSidecarRecordingCapture,
} from "./lunaHostApi";
import { VoiceSidecarContent } from "./VoiceSidecarContent";
import { applyDictionaryCorrections, selectDictationTerms } from "./dictationVocabulary";
import { useLunaCues } from "./lunaCues";
import {
  forgetCachedSession,
  readCachedSession,
  sessionCacheKey,
  writeCachedSession,
} from "./voiceSidecarSessionCache";
import {
  localDictationAvailable,
  prepareLocalDictation,
  transcribeWithLocalDictation,
} from "./lunaDictation";
import {
  buildVoiceSidecarHandoffMessage,
  resolveCompletedAssistantSourceText,
  resolveVoiceSidecarHandoffText,
  type VoiceSidecarHandoffContent,
} from "./voiceSidecarHandoff";
import {
  classifyVoiceCommand,
  latestCompleteAssistantMessage,
  type VoiceCommand,
} from "./voiceSidecarPresentation";
import { useVoiceSidecarSpeech } from "./voiceSidecarSpeech";

type VoiceSidecarSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly sourceMessageId: string;
}>;

const VOICE_SIDECAR_SOURCE_TEXT_MAX_LENGTH = 120_000;
const POLL_BUSY_MS = 1_200;
const POLL_IDLE_MS = 6_000;

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function VoiceSidecarSheet(props: VoiceSidecarSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const sourceEnvironmentId = EnvironmentId.make(props.route.params.environmentId);
  const sourceThreadId = ThreadId.make(props.route.params.threadId);
  const sourceMessageId = MessageId.make(props.route.params.sourceMessageId);
  const lunaHost = useLunaHost();
  const client = lunaHost.client;
  const sourceThreadState = useEnvironmentThread(sourceEnvironmentId, sourceThreadId);
  const sourceThread = Option.getOrNull(sourceThreadState.data);
  const sourceText = sourceThread
    ? resolveCompletedAssistantSourceText(sourceThread.messages, sourceMessageId)
    : null;

  const [snapshot, setSnapshot] = useState<LunaSnapshot | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>("open");
  const [asking, setAsking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [openAttempt, setOpenAttempt] = useState(0);
  const [localDictation, setLocalDictation] = useState(false);
  const [localDictationNotice, setLocalDictationNotice] = useState<string | null>(null);
  const snapshotRef = useRef<LunaSnapshot | null>(null);
  snapshotRef.current = snapshot;

  useEffect(() => {
    let active = true;
    void localDictationAvailable().then((available) => {
      if (!active) return;
      setLocalDictation(available);
      // Warm the model while the user reads the synopsis, before any recording.
      if (available) prepareLocalDictation();
    });
    return () => {
      active = false;
    };
  }, []);
  const openedIdentityRef = useRef<string | null>(null);
  const identity = sessionCacheKey({
    environmentId: sourceEnvironmentId,
    threadId: sourceThreadId,
    messageId: sourceMessageId,
    hostUrl: client?.baseUrl ?? "no-host",
  });

  // Every snapshot this sheet sees is remembered, so coming back to the same
  // response resumes at once instead of waiting on the host.
  useEffect(() => {
    if (snapshot !== null) writeCachedSession(identity, snapshot);
  }, [identity, snapshot]);

  useEffect(() => {
    if (!lunaHost.isReady) return;
    const attemptIdentity = `${identity}:${openAttempt}`;
    if (openedIdentityRef.current === attemptIdentity) return;
    const cached = client === null ? null : readCachedSession(identity);
    if (cached !== null && client !== null) {
      // Resume: render the last known state now, refresh quietly, and only
      // fall back to a full open when the host no longer knows the session.
      openedIdentityRef.current = attemptIdentity;
      setSnapshot(cached);
      setLocalError(null);
      setPendingAction(null);
      let cancelled = false;
      client
        .getSnapshot(cached.session.id)
        .then((fresh) => {
          if (!cancelled) setSnapshot(fresh);
        })
        .catch(() => {
          if (cancelled) return;
          forgetCachedSession(identity);
          openedIdentityRef.current = null;
          setOpenAttempt((attempt) => attempt + 1);
        });
      return () => {
        cancelled = true;
      };
    }
    if (Option.isNone(sourceThreadState.data)) return;
    openedIdentityRef.current = attemptIdentity;
    setSnapshot(null);
    setLocalError(null);
    if (client === null) {
      setPendingAction(null);
      setLocalError("Add the Luna voice host URL and token in Settings → Voice & Luna first.");
      return;
    }
    if (sourceText === null || sourceText.length === 0) {
      setPendingAction(null);
      setLocalError("This response is not a completed assistant message.");
      return;
    }
    if (sourceText.length > VOICE_SIDECAR_SOURCE_TEXT_MAX_LENGTH) {
      setPendingAction(null);
      setLocalError(
        "This response is too long for Luna. Voice & Luna supports completed responses up to 120,000 characters.",
      );
      return;
    }
    setPendingAction("open");
    let cancelled = false;
    client
      .openSession({
        source: {
          environmentId: sourceEnvironmentId,
          threadId: sourceThreadId,
          messageId: sourceMessageId,
        },
        sourceText,
      })
      .then((opened) => {
        if (cancelled) return;
        setSnapshot(opened);
        setPendingAction(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLocalError(messageOf(error, "Could not open Luna for this response."));
        setPendingAction(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    client,
    identity,
    lunaHost.isReady,
    openAttempt,
    sourceEnvironmentId,
    sourceMessageId,
    sourceText,
    sourceThreadId,
    sourceThreadState.data,
  ]);

  // The host has no push channel, so the open sheet polls: quickly while Luna
  // is answering, slowly otherwise to catch dictionary or retention changes.
  const sessionId = snapshot?.session.id ?? null;
  const waiting = snapshot?.session.status === "waiting-for-luna";
  useEffect(() => {
    if (client === null || sessionId === null) return;
    let cancelled = false;
    const interval = setInterval(
      () => {
        client
          .getSnapshot(sessionId)
          .then((fresh) => {
            if (!cancelled) setSnapshot(fresh);
          })
          .catch(() => {
            // Transient poll failures keep the last snapshot; commands surface errors.
          });
      },
      waiting ? POLL_BUSY_MS : POLL_IDLE_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [client, sessionId, waiting]);

  const speech = useVoiceSidecarSpeech({
    client,
    sessionId,
    messages: snapshot?.session.messages ?? [],
    enabled: snapshot?.session.availability.synthesis === "ready",
  });

  const sessionError =
    snapshot?.session.status === "error"
      ? (snapshot.session.lastError ?? "Luna hit an error.")
      : null;
  const latestAssistantId = latestCompleteAssistantMessage(snapshot?.session.messages ?? [])?.id;
  const latestSpeech =
    latestAssistantId === undefined ? undefined : speech.speechByMessageId[latestAssistantId];
  const cues = useLunaCues({
    processing:
      pendingAction === "open" || asking || waiting === true || latestSpeech?.status === "loading",
    errorKey: localError ?? sessionError ?? latestSpeech?.error ?? null,
  });

  const runCommand = useCallback(
    async (label: string, command: () => Promise<LunaSnapshot>): Promise<void> => {
      setPendingAction(label);
      setLocalError(null);
      try {
        setSnapshot(await command());
      } catch (error) {
        const message = messageOf(error, `Could not ${label}.`);
        setLocalError(message);
        throw new Error(message);
      } finally {
        setPendingAction(null);
      }
    },
    [],
  );

  const replayLatest = useCallback(() => {
    const latest = latestCompleteAssistantMessage(snapshotRef.current?.session.messages ?? []);
    if (latest === null) throw new Error("There is nothing to replay yet.");
    void speech.requestSpeech(latest.id, true);
  }, [speech]);

  const draftNextPrompt = useCallback(async () => {
    if (client === null || sessionId === null) {
      throw new Error("The Luna voice host is not connected.");
    }
    setAsking(true);
    try {
      await runCommand("draft the next prompt", () => client.draftNextPrompt(sessionId, uuidv4()));
    } finally {
      setAsking(false);
    }
  }, [client, runCommand, sessionId]);

  const runVoiceCommand = useCallback(
    async (command: VoiceCommand) => {
      if (client === null || sessionId === null) {
        throw new Error("The Luna voice host is not connected.");
      }
      switch (command._tag) {
        case "replay":
          replayLatest();
          return;
        case "next-prompt":
          setSnapshot(await client.draftNextPrompt(sessionId, uuidv4()));
          return;
        case "ask":
          setSnapshot(await client.askText(sessionId, uuidv4(), command.text));
          return;
      }
    },
    [client, replayLatest, sessionId],
  );

  const askRecording = useCallback(
    async (capture: VoiceSidecarRecordingCapture) => {
      if (client === null || sessionId === null) {
        throw new Error("The Luna voice host is not connected.");
      }
      setPendingAction("send recording");
      setAsking(true);
      setLocalError(null);
      try {
        // Transcribe on-device when possible: no audio upload, no API cost,
        // dictionary terms biasing recognition directly. The host's
        // gpt-transcribe path stays as the fallback. Either way the words
        // come back here first, so "replay" never reaches Luna as a question.
        const dictionary = snapshotRef.current?.dictionary.entries ?? [];
        let text: string | null = null;
        if (localDictation) {
          try {
            const raw = await transcribeWithLocalDictation(
              capture.uri,
              selectDictationTerms(dictionary),
            );
            text = applyDictionaryCorrections(raw, dictionary).trim();
            setLocalDictationNotice(null);
          } catch (error) {
            // Fall back to the host upload, but say so: a silent fallback
            // reads as "on-device is slow" and hides the actual failure.
            setLocalDictationNotice(messageOf(error, "On-device transcription failed."));
            const hostReady = snapshotRef.current?.session.availability.transcription === "ready";
            if (!hostReady) throw error;
          }
        }
        if (text === null) {
          text = (await client.transcribeRecording(sessionId, capture)).text.trim();
        }
        if (text.length === 0) {
          throw new Error("Nothing was heard in the recording.");
        }
        await runVoiceCommand(classifyVoiceCommand(text));
      } catch (error) {
        const message = messageOf(error, "Could not send the recording.");
        setLocalError(message);
        throw new Error(message);
      } finally {
        setAsking(false);
        setPendingAction(null);
      }
    },
    [client, localDictation, runVoiceCommand, sessionId],
  );

  const close = useCallback(() => navigation.goBack(), [navigation]);

  if (!snapshot || client === null || sessionId === null) {
    return (
      <View
        collapsable={false}
        className="flex-1 items-center justify-center gap-3 bg-sheet px-6"
        style={{ paddingTop: Platform.OS === "android" ? insets.top : 0 }}
      >
        {pendingAction ? <ActivityIndicator size="large" /> : null}
        <Text className="text-lg font-t3-bold text-foreground">
          {pendingAction ? "Opening Luna" : "Luna unavailable"}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          {localError ?? "Starting a subscription-backed Codex conversation for this response."}
        </Text>
        <View className="mt-2 flex-row gap-3">
          <Pressable
            accessibilityLabel="Close Luna"
            accessibilityRole="button"
            className="min-h-11 items-center justify-center rounded-full border border-border bg-card px-5 active:opacity-70"
            onPress={close}
          >
            <Text className="font-t3-bold text-sm text-foreground">Close</Text>
          </Pressable>
          {!pendingAction ? (
            <Pressable
              accessibilityLabel="Retry opening Luna"
              accessibilityRole="button"
              className="min-h-11 items-center justify-center rounded-full bg-primary px-5 active:opacity-70"
              onPress={() => setOpenAttempt((attempt) => attempt + 1)}
            >
              <Text className="font-t3-bold text-sm text-primary-foreground">Retry</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View
      collapsable={false}
      className="flex-1"
      style={{ paddingTop: Platform.OS === "android" ? insets.top : 0 }}
    >
      <VoiceSidecarContent
        snapshot={snapshot}
        pendingAction={pendingAction}
        asking={asking}
        error={localError ?? sessionError}
        localTranscriptionAvailable={localDictation}
        localTranscriptionNotice={localDictationNotice}
        onClose={close}
        getRecordingUrl={(messageId) => client.recordingUrl(sessionId, messageId)}
        onAskRecording={askRecording}
        onAskText={async (text) => {
          setAsking(true);
          try {
            await runCommand("ask Luna", () => client.askText(sessionId, uuidv4(), text));
          } finally {
            setAsking(false);
          }
        }}
        onDraftNextPrompt={draftNextPrompt}
        onSetPreferences={(preferences: LunaSessionPreferences) =>
          runCommand("update Luna preferences", () =>
            client.setPreferences(sessionId, uuidv4(), preferences),
          )
        }
        onTeach={(messageId, correctedText) =>
          runCommand("teach the dictionary", () =>
            client.teach(sessionId, messageId, correctedText),
          )
        }
        onDeleteEntry={(entryId) =>
          runCommand("remove the learned entry", async () => ({
            ...snapshot,
            dictionary: await client.deleteDictionaryEntry(entryId),
          }))
        }
        onUpsertEntry={(entryId, value) =>
          runCommand(entryId ? "update the learned entry" : "add the learned entry", async () => ({
            ...snapshot,
            dictionary: await client.upsertDictionaryEntry({
              ...(entryId === undefined ? {} : { entryId }),
              kind: value.kind,
              phrase: value.phrase,
              ...(value.replacement === undefined ? {} : { replacement: value.replacement }),
            }),
          }))
        }
        onSyncWispr={() =>
          runCommand("sync the Wispr dictionary", async () => ({
            ...snapshot,
            dictionary: await client.syncWispr(),
          }))
        }
        playErrorCue={cues.playError}
        speechByMessageId={speech.speechByMessageId}
        onRequestSpeech={(messageId) => speech.requestSpeech(messageId, true)}
        onSpeechAutoPlayed={speech.consumeAutoPlay}
        onSendHandoff={async (content: VoiceSidecarHandoffContent) => {
          setPendingAction("send the response to the main thread");
          setLocalError(null);
          try {
            if (sourceThread === null) {
              throw new Error("The source thread is not available on this device.");
            }
            const text = resolveVoiceSidecarHandoffText(content, snapshot);
            await enqueueThreadOutboxMessage(
              buildVoiceSidecarHandoffMessage({
                environmentId: sourceEnvironmentId,
                threadId: sourceThreadId,
                text,
                metadata: makeQueuedMessageMetadata(),
              }),
            );
            close();
          } catch (error) {
            setLocalError(messageOf(error, "Could not queue the response for the source thread."));
            throw error;
          } finally {
            setPendingAction(null);
          }
        }}
      />
    </View>
  );
}
