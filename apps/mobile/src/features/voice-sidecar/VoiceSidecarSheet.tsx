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
  const identity = `${sourceEnvironmentId}:${sourceThreadId}:${sourceMessageId}:${client?.baseUrl ?? "no-host"}`;

  useEffect(() => {
    if (!lunaHost.isReady || Option.isNone(sourceThreadState.data)) return;
    const attemptIdentity = `${identity}:${openAttempt}`;
    if (openedIdentityRef.current === attemptIdentity) return;
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

  const askRecording = useCallback(
    async (capture: VoiceSidecarRecordingCapture) => {
      if (client === null || sessionId === null) {
        throw new Error("The Luna voice host is not connected.");
      }
      setPendingAction("send recording");
      setLocalError(null);
      try {
        // Transcribe on-device when possible: no audio upload, no API cost,
        // dictionary terms biasing recognition directly. The host's
        // gpt-transcribe path stays as the fallback.
        const dictionary = snapshotRef.current?.dictionary.entries ?? [];
        let localText: string | null = null;
        if (localDictation) {
          try {
            const raw = await transcribeWithLocalDictation(
              capture.uri,
              selectDictationTerms(dictionary),
            );
            localText = applyDictionaryCorrections(raw, dictionary).trim();
            setLocalDictationNotice(null);
          } catch (error) {
            // Fall back to the host upload, but say so: a silent fallback
            // reads as "on-device is slow" and hides the actual failure.
            setLocalDictationNotice(messageOf(error, "On-device transcription failed."));
            const hostReady = snapshotRef.current?.session.availability.transcription === "ready";
            if (!hostReady) throw error;
            localText = null;
          }
        }
        if (localText !== null && localText.length === 0) {
          throw new Error("Nothing was heard in the recording.");
        }
        if (localText !== null) {
          setSnapshot(await client.askText(sessionId, uuidv4(), localText));
        } else {
          await client.askRecording(sessionId, uuidv4(), capture);
          setSnapshot(await client.getSnapshot(sessionId));
        }
      } catch (error) {
        const message = messageOf(error, "Could not send the recording.");
        setLocalError(message);
        throw new Error(message);
      } finally {
        setPendingAction(null);
      }
    },
    [client, localDictation, sessionId],
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

  const sessionError =
    snapshot.session.status === "error"
      ? (snapshot.session.lastError ?? "Luna hit an error.")
      : null;

  return (
    <View
      collapsable={false}
      className="flex-1"
      style={{ paddingTop: Platform.OS === "android" ? insets.top : 0 }}
    >
      <VoiceSidecarContent
        snapshot={snapshot}
        pendingAction={pendingAction}
        error={localError ?? sessionError}
        localTranscriptionAvailable={localDictation}
        localTranscriptionNotice={localDictationNotice}
        onClose={close}
        getRecordingUrl={(messageId) => client.recordingUrl(sessionId, messageId)}
        onAskRecording={askRecording}
        onAskText={(text) =>
          runCommand("ask Luna", () => client.askText(sessionId, uuidv4(), text))
        }
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
                thread: sourceThread,
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
