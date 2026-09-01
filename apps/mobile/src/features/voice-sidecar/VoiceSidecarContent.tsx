import { memo, useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import IconMicrophone from "@tabler/icons-react-native/IconMicrophone";
import { withUniwind } from "uniwind";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import type {
  LunaDictionaryEntry,
  LunaMessage,
  LunaSessionPreferences,
  LunaSnapshot,
  VoiceSidecarRecordingCapture,
} from "./lunaHostApi";
import type { VoiceSidecarHandoffContent } from "./voiceSidecarHandoff";
import {
  VoiceSidecarAudioPlayer,
  type VoiceSidecarPlaybackCoordinator,
} from "./VoiceSidecarAudioPlayer";
import type { VoiceSidecarSpeechState } from "./voiceSidecarSpeech";
import { useVoiceSidecarRecorder } from "./useVoiceSidecarRecorder";
import {
  dictionaryEntryLabel,
  latestCompleteAssistantMessage,
  sentenceCountLabel,
  serviceStatusLabel,
} from "./voiceSidecarPresentation";

type SidecarPage = "road" | "history" | "dictionary";
const ThemedMicrophone = withUniwind(IconMicrophone);
type DictionaryDraft =
  | { readonly mode: "term"; readonly entryId?: string; readonly term: string }
  | {
      readonly mode: "correction";
      readonly entryId?: string;
      readonly from: string;
      readonly to: string;
    };

export interface LunaDictionaryEntryDraft {
  readonly kind: "term" | "correction";
  readonly phrase: string;
  readonly replacement?: string;
}

export interface VoiceSidecarContentProps {
  readonly snapshot: LunaSnapshot;
  readonly pendingAction: string | null;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly getRecordingUrl: (messageId: string) => string;
  readonly onAskRecording: (capture: VoiceSidecarRecordingCapture) => Promise<void>;
  readonly onAskText: (text: string) => Promise<void>;
  readonly onSetPreferences: (preferences: LunaSessionPreferences) => Promise<void>;
  readonly onTeach: (messageId: string, correctedText: string) => Promise<void>;
  readonly onDeleteEntry: (entryId: string) => Promise<void>;
  readonly onUpsertEntry: (
    entryId: string | undefined,
    value: LunaDictionaryEntryDraft,
  ) => Promise<void>;
  readonly onSyncWispr: () => Promise<void>;
  readonly speechByMessageId: Readonly<Record<string, VoiceSidecarSpeechState>>;
  readonly onRequestSpeech: (messageId: string) => Promise<void>;
  readonly onSpeechAutoPlayed: (messageId: string) => void;
  readonly onSendHandoff: (content: VoiceSidecarHandoffContent) => Promise<void>;
}

type VoiceSidecarPageProps = VoiceSidecarContentProps & {
  readonly playbackCoordinator: VoiceSidecarPlaybackCoordinator;
};

function runUiAction(action: () => Promise<void>): void {
  void action().catch(() => {
    // The sheet presents command failures in its error banner.
  });
}

function ActionButton(props: {
  readonly label: string;
  readonly icon: Parameters<typeof SymbolView>[0]["name"];
  readonly disabled?: boolean;
  readonly primary?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.primary
          ? "min-h-11 flex-row items-center justify-center gap-2 rounded-full bg-primary px-4 disabled:opacity-40"
          : "min-h-11 flex-row items-center justify-center gap-2 rounded-full border border-border bg-card px-4 disabled:opacity-40"
      }
    >
      <SymbolView
        name={props.icon}
        size={15}
        tintColorClassName={props.primary ? "accent-primary-foreground" : "accent-icon"}
        type="monochrome"
      />
      <Text
        className={
          props.primary
            ? "font-t3-bold text-sm text-primary-foreground"
            : "font-t3-bold text-sm text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function SegmentedOptions<T extends string | number>(props: {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly value: T;
  readonly disabled?: boolean;
  readonly onChange: (value: T) => void;
}) {
  return (
    <View className="gap-2">
      <Text className="px-1 text-xs font-t3-bold uppercase text-foreground-muted">
        {props.label}
      </Text>
      <View className="flex-row rounded-[18px] bg-subtle p-1">
        {props.options.map((option) => {
          const selected = option.value === props.value;
          return (
            <Pressable
              key={String(option.value)}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: props.disabled }}
              className={
                selected
                  ? "min-h-9 flex-1 items-center justify-center rounded-[14px] bg-card px-2"
                  : "min-h-9 flex-1 items-center justify-center rounded-[14px] px-2"
              }
              disabled={props.disabled}
              onPress={() => props.onChange(option.value)}
            >
              <Text
                className={
                  selected
                    ? "font-t3-bold text-sm text-foreground"
                    : "font-t3-medium text-sm text-foreground-muted"
                }
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const MessageAudio = memo(function MessageAudio(props: {
  readonly message: LunaMessage;
  readonly recordingUrl: string | null;
  readonly speech: VoiceSidecarSpeechState | undefined;
  readonly synthesisAvailable: boolean;
  readonly disabled: boolean;
  readonly playbackCoordinator: VoiceSidecarPlaybackCoordinator;
  readonly onRequestSpeech: (messageId: string) => Promise<void>;
  readonly onSpeechAutoPlayed: (messageId: string) => void;
  readonly autoPlay?: boolean;
}) {
  if (props.message.role === "assistant") {
    if (props.speech?.status === "loading") {
      return (
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
          <Text className="text-xs text-foreground-muted">Preparing Luna audio</Text>
        </View>
      );
    }
    if (props.speech?.status !== "ready" || !props.speech.uri) {
      return (
        <View className="gap-2">
          {props.speech?.error ? (
            <Text className="text-xs text-danger-foreground">{props.speech.error}</Text>
          ) : null}
          <ActionButton
            label={props.speech?.status === "error" ? "Try audio again" : "Read aloud"}
            icon="play"
            disabled={props.disabled || !props.synthesisAvailable}
            onPress={() => runUiAction(() => props.onRequestSpeech(props.message.id))}
          />
        </View>
      );
    }
    return (
      <VoiceSidecarAudioPlayer
        url={props.speech.uri}
        autoPlay={props.autoPlay && props.speech.shouldAutoPlay}
        compact
        coordinator={props.playbackCoordinator}
        disabled={props.disabled}
        label="Luna audio"
        onAutoPlayConsumed={() => props.onSpeechAutoPlayed(props.message.id)}
      />
    );
  }

  if (props.recordingUrl === null) return null;
  return (
    <VoiceSidecarAudioPlayer
      url={props.recordingUrl}
      compact
      coordinator={props.playbackCoordinator}
      disabled={props.disabled}
      label="Recording"
    />
  );
});

function SidecarHeader(props: {
  readonly page: SidecarPage;
  readonly onClose: () => void;
  readonly onChangePage: (page: SidecarPage) => void;
}) {
  return (
    <View className="border-b border-border bg-sheet px-4 pb-3 pt-2">
      <View className="flex-row items-center justify-between">
        <Pressable
          accessibilityLabel="Close Luna"
          accessibilityRole="button"
          className="size-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
          onPress={props.onClose}
        >
          <SymbolView name="xmark" size={16} tintColorClassName="accent-icon" type="monochrome" />
        </Pressable>
        <View className="items-center">
          <Text className="text-lg font-t3-bold text-foreground">Luna</Text>
          <Text className="text-xs text-foreground-muted">Voice sidecar</Text>
        </View>
        <View className="size-11 items-center justify-center rounded-full bg-subtle">
          <SymbolView
            name={{ ios: "waveform", android: "auto_awesome" }}
            size={17}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        </View>
      </View>
      <View className="mt-3 flex-row rounded-[16px] bg-subtle p-1">
        {(
          [
            ["road", "Road"],
            ["history", "History"],
            ["dictionary", "Dictionary"],
          ] as const
        ).map(([value, label]) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityState={{ selected: props.page === value }}
            className={
              props.page === value
                ? "min-h-9 flex-1 items-center justify-center rounded-[12px] bg-card"
                : "min-h-9 flex-1 items-center justify-center rounded-[12px]"
            }
            onPress={() => props.onChangePage(value)}
          >
            <Text
              className={
                props.page === value
                  ? "font-t3-bold text-sm text-foreground"
                  : "font-t3-medium text-sm text-foreground-muted"
              }
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function RoadView(props: VoiceSidecarPageProps) {
  const session = props.snapshot.session;
  const [text, setText] = useState("");
  const latestAssistant = latestCompleteAssistantMessage(session.messages);
  const waitingLabel = "Luna is answering";
  const recorder = useVoiceSidecarRecorder({
    disabled: props.pendingAction !== null || session.availability.transcription !== "ready",
    onCapture: props.onAskRecording,
  });
  const recordingActive = recorder.state.phase !== "idle" && recorder.state.phase !== "error";
  const busy = props.pendingAction !== null || session.status === "waiting-for-luna";
  const ask = useCallback(async () => {
    const next = text.trim();
    if (!next) return;
    await props.onAskText(next);
    setText("");
  }, [props, text]);
  const sendToThread = useCallback(async () => {
    const next = text.trim();
    if (!next) return;
    await props.onSendHandoff({ _tag: "text", text: next });
    setText("");
  }, [props, text]);

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-5 px-5 py-5"
    >
      {session.availability.luna !== "ready" ||
      session.availability.transcription !== "ready" ||
      session.availability.synthesis !== "ready" ? (
        <View className="gap-2 rounded-[20px] border border-border bg-card px-4 py-3">
          <Text className="font-t3-bold text-sm text-foreground">Service status</Text>
          <Text className="text-sm text-foreground-muted">
            Luna: {serviceStatusLabel(session.availability.luna)} · Transcription:{" "}
            {serviceStatusLabel(session.availability.transcription)} · Kokoro:{" "}
            {serviceStatusLabel(session.availability.synthesis)}
          </Text>
        </View>
      ) : null}

      <View className="gap-3 rounded-[24px] border border-border bg-card px-5 py-5">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-xs font-t3-bold uppercase text-foreground-muted">Synopsis</Text>
          {session.status === "waiting-for-luna" ? (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
              <Text className="text-xs text-foreground-muted">{waitingLabel}</Text>
            </View>
          ) : null}
        </View>
        <Text className="text-lg leading-relaxed text-foreground">
          {latestAssistant?.text || "Luna is preparing a short synopsis of the finished output."}
        </Text>
        {latestAssistant ? (
          <MessageAudio
            recordingUrl={null}
            message={latestAssistant}
            speech={props.speechByMessageId[latestAssistant.id]}
            synthesisAvailable={session.availability.synthesis === "ready"}
            disabled={busy || recordingActive}
            playbackCoordinator={props.playbackCoordinator}
            onRequestSpeech={props.onRequestSpeech}
            onSpeechAutoPlayed={props.onSpeechAutoPlayed}
            autoPlay={!recordingActive}
          />
        ) : null}
      </View>

      <View className="gap-4">
        <SegmentedOptions
          label="Reasoning"
          value={session.preferences.reasoningEffort}
          disabled={busy}
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ]}
          onChange={(reasoningEffort) =>
            runUiAction(() => props.onSetPreferences({ ...session.preferences, reasoningEffort }))
          }
        />
        <SegmentedOptions
          label="Synopsis length"
          value={session.preferences.synopsisSentences}
          disabled={busy}
          options={([1, 2, 3] as const).map((value) => ({
            value,
            label: sentenceCountLabel(value),
          }))}
          onChange={(synopsisSentences) =>
            runUiAction(() => props.onSetPreferences({ ...session.preferences, synopsisSentences }))
          }
        />
      </View>

      <View className="items-center gap-3 rounded-[24px] bg-subtle px-5 py-5">
        <Pressable
          accessibilityLabel={recorder.state.phase === "recording" ? "Done recording" : "Record"}
          accessibilityRole="button"
          disabled={
            busy ||
            recorder.state.phase === "preparing" ||
            recorder.state.phase === "submitting" ||
            session.availability.transcription !== "ready"
          }
          className={
            recorder.state.phase === "recording"
              ? "size-24 items-center justify-center rounded-full bg-primary"
              : "size-24 items-center justify-center rounded-full border border-border bg-card disabled:opacity-40"
          }
          onPress={() => {
            if (recorder.state.phase === "recording") {
              void recorder.stop();
            } else {
              props.playbackCoordinator.stopActive();
              void recorder.start();
            }
          }}
        >
          {recorder.state.phase === "preparing" || recorder.state.phase === "submitting" ? (
            <ActivityIndicator size="large" colorClassName="accent-icon-muted" />
          ) : recorder.state.phase === "recording" ? (
            <View className="items-center gap-1">
              <SymbolView
                name="checkmark"
                size={24}
                tintColorClassName="accent-primary-foreground"
                type="monochrome"
              />
              <Text className="font-t3-bold text-xs text-primary-foreground">Done</Text>
            </View>
          ) : Platform.OS === "android" ? (
            <ThemedMicrophone size={28} colorClassName="accent-icon" />
          ) : (
            <SymbolView name="mic" size={28} tintColorClassName="accent-icon" type="monochrome" />
          )}
        </Pressable>
        <Text className="text-center text-sm text-foreground-muted">
          {recorder.state.phase === "recording"
            ? `Recording ${Math.floor(recorder.elapsedSeconds / 60)}:${String(recorder.elapsedSeconds % 60).padStart(2, "0")}`
            : recorder.state.phase === "submitting"
              ? "Sending for transcription"
              : "Tap to ask Luna by voice"}
        </Text>
        {recorder.state.phase === "error" ? (
          <Pressable onPress={recorder.dismissError}>
            <Text className="text-center text-sm text-danger-foreground">
              {recorder.state.error} Tap to dismiss.
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View className="gap-3 rounded-[24px] border border-border bg-card p-4">
        <TextInput
          multiline
          className="min-h-20 rounded-[16px] bg-subtle px-4 py-3 text-base text-foreground"
          placeholder="Ask Luna, or write a reply for the main thread"
          textAlignVertical="top"
          value={text}
          onChangeText={setText}
        />
        <View className="flex-row gap-2">
          <View className="flex-1">
            <ActionButton
              label="Ask Luna"
              icon="text.bubble"
              disabled={busy || text.trim().length === 0}
              onPress={() => runUiAction(ask)}
            />
          </View>
          <View className="flex-1">
            <ActionButton
              label="Send to thread"
              icon="arrow.up"
              primary
              disabled={busy || text.trim().length === 0}
              onPress={() => runUiAction(sendToThread)}
            />
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

function HistoryView(props: VoiceSidecarPageProps) {
  const [teachingMessage, setTeachingMessage] = useState<LunaMessage | null>(null);
  const [correctedText, setCorrectedText] = useState("");
  const busy = props.pendingAction !== null || props.snapshot.session.status === "waiting-for-luna";

  if (teachingMessage) {
    return (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-4 px-5 py-5"
      >
        <Text className="text-xl font-t3-bold text-foreground">Teach the dictionary</Text>
        <Text className="text-sm leading-normal text-foreground-muted">
          This saves changed words for future transcriptions. It does not rewrite this history or
          send anything new to Luna.
        </Text>
        <View className="gap-2 rounded-[20px] border border-border bg-card p-4">
          <Text className="text-xs font-t3-bold uppercase text-foreground-muted">
            Original transcript
          </Text>
          <Text selectable className="text-base leading-normal text-foreground">
            {teachingMessage.text}
          </Text>
        </View>
        <View className="gap-2">
          <Text className="px-1 text-xs font-t3-bold uppercase text-foreground-muted">
            What I said
          </Text>
          <TextInput
            autoFocus
            multiline
            className="min-h-32 rounded-[20px] border border-border bg-card px-4 py-3 text-base text-foreground"
            textAlignVertical="top"
            value={correctedText}
            onChangeText={setCorrectedText}
          />
        </View>
        <View className="flex-row gap-2">
          <View className="flex-1">
            <ActionButton
              label="Cancel"
              icon="xmark"
              disabled={busy}
              onPress={() => setTeachingMessage(null)}
            />
          </View>
          <View className="flex-1">
            <ActionButton
              label="Add to dictionary"
              icon="checkmark"
              primary
              disabled={
                busy ||
                correctedText.trim().length === 0 ||
                correctedText.trim() === teachingMessage.text.trim()
              }
              onPress={() =>
                runUiAction(async () => {
                  await props.onTeach(teachingMessage.id, correctedText.trim());
                  setTeachingMessage(null);
                  setCorrectedText("");
                })
              }
            />
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-3 px-5 py-5">
      <View className="gap-1 px-1">
        <Text className="text-sm font-t3-bold text-foreground">Exact Luna history</Text>
        <Text className="text-sm leading-normal text-foreground-muted">
          These transcripts are immutable. Teaching creates dictionary rules for future recordings.
        </Text>
      </View>
      {props.snapshot.session.messages.map((message) => (
        <View
          key={message.id}
          className={
            message.role === "user"
              ? "ml-8 gap-3 rounded-[20px] bg-subtle px-4 py-3"
              : "mr-8 gap-3 rounded-[20px] border border-border bg-card px-4 py-3"
          }
        >
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-xs font-t3-bold uppercase text-foreground-muted">
              {message.role === "assistant" ? "Luna" : "You"}
            </Text>
            <Text className="text-xs text-foreground-muted">{message.status}</Text>
          </View>
          <Text selectable className="text-base leading-normal text-foreground">
            {message.text}
          </Text>
          <MessageAudio
            recordingUrl={message.hasRecording ? props.getRecordingUrl(message.id) : null}
            message={message}
            speech={props.speechByMessageId[message.id]}
            synthesisAvailable={props.snapshot.session.availability.synthesis === "ready"}
            disabled={busy}
            playbackCoordinator={props.playbackCoordinator}
            onRequestSpeech={props.onRequestSpeech}
            onSpeechAutoPlayed={props.onSpeechAutoPlayed}
          />
          {message.role === "user" && message.text.trim() ? (
            <ActionButton
              label="Teach correction"
              icon="square.and.pencil"
              disabled={busy}
              onPress={() => {
                setTeachingMessage(message);
                setCorrectedText(message.text);
              }}
            />
          ) : null}
          {message.role === "assistant" && message.status === "complete" ? (
            <ActionButton
              label="Send this to the main thread"
              icon="arrow.up"
              primary
              disabled={busy}
              onPress={() =>
                runUiAction(() =>
                  props.onSendHandoff({ _tag: "assistant-message", messageId: message.id }),
                )
              }
            />
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}

function draftForEntry(entry: LunaDictionaryEntry): DictionaryDraft {
  return entry.kind === "term"
    ? { mode: "term", entryId: entry.id, term: entry.phrase }
    : { mode: "correction", entryId: entry.id, from: entry.phrase, to: entry.replacement ?? "" };
}

function DictionaryView(props: VoiceSidecarPageProps) {
  const dictionary = props.snapshot.dictionary;
  const [draft, setDraft] = useState<DictionaryDraft | null>(null);
  const [query, setQuery] = useState("");
  const busy = props.pendingAction !== null || props.snapshot.session.status === "waiting-for-luna";
  const matchingEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = normalizedQuery
      ? dictionary.entries.filter((entry) =>
          dictionaryEntryLabel(entry).toLocaleLowerCase().includes(normalizedQuery),
        )
      : dictionary.entries;
    return {
      total: matches.length,
      visible: matches.slice(0, 100),
    };
  }, [dictionary.entries, query]);
  const saveDraft = useCallback(async () => {
    if (!draft) return;
    const value: LunaDictionaryEntryDraft =
      draft.mode === "term"
        ? { kind: "term", phrase: draft.term.trim() }
        : { kind: "correction", phrase: draft.from.trim(), replacement: draft.to.trim() };
    await props.onUpsertEntry(draft.entryId, value);
    setDraft(null);
  }, [draft, props]);

  if (draft) {
    const valid =
      draft.mode === "term"
        ? draft.term.trim().length > 0
        : draft.from.trim().length > 0 && draft.to.trim().length > 0;
    return (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-4 px-5 py-5"
      >
        <Text className="text-xl font-t3-bold text-foreground">
          {draft.entryId ? "Edit learned entry" : "Add known words"}
        </Text>
        {draft.mode === "term" ? (
          <TextInput
            autoFocus
            className="min-h-12 rounded-[18px] border border-border bg-card px-4 text-base text-foreground"
            placeholder="Name, product, or acronym"
            value={draft.term}
            onChangeText={(term) => setDraft({ ...draft, term })}
          />
        ) : (
          <View className="gap-3">
            <TextInput
              autoFocus
              className="min-h-12 rounded-[18px] border border-border bg-card px-4 text-base text-foreground"
              placeholder="What transcription heard"
              value={draft.from}
              onChangeText={(from) => setDraft({ ...draft, from })}
            />
            <TextInput
              className="min-h-12 rounded-[18px] border border-border bg-card px-4 text-base text-foreground"
              placeholder="What it should be"
              value={draft.to}
              onChangeText={(to) => setDraft({ ...draft, to })}
            />
          </View>
        )}
        <View className="flex-row gap-2">
          <View className="flex-1">
            <ActionButton label="Cancel" icon="xmark" onPress={() => setDraft(null)} />
          </View>
          <View className="flex-1">
            <ActionButton
              label="Save"
              icon="checkmark"
              primary
              disabled={busy || !valid}
              onPress={() => runUiAction(saveDraft)}
            />
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-5 px-5 py-5">
      <View className="gap-3 rounded-[24px] border border-border bg-card p-4">
        <View className="flex-row items-center justify-between gap-3">
          <View className="min-w-0 flex-1">
            <Text className="font-t3-bold text-base text-foreground">Wispr Flow</Text>
            <Text className="text-sm text-foreground-muted">
              {dictionary.wispr.status} · {dictionary.wispr.vocabularyCount} terms ·{" "}
              {dictionary.wispr.correctionCount} corrections
            </Text>
          </View>
        </View>
        <Text className="text-xs leading-normal text-foreground-muted">
          Text-expansion snippets are skipped because they are not literal transcription vocabulary.
        </Text>
        <ActionButton
          label="Sync Wispr now"
          icon="arrow.clockwise"
          disabled={busy}
          onPress={() => runUiAction(props.onSyncWispr)}
        />
      </View>

      <View className="flex-row gap-2">
        <View className="flex-1">
          <ActionButton
            label="Add term"
            icon="plus"
            disabled={busy}
            onPress={() => setDraft({ mode: "term", term: "" })}
          />
        </View>
        <View className="flex-1">
          <ActionButton
            label="Add correction"
            icon="plus"
            disabled={busy}
            onPress={() => setDraft({ mode: "correction", from: "", to: "" })}
          />
        </View>
      </View>

      <View className="gap-2">
        <TextInput
          className="min-h-12 rounded-[18px] border border-border bg-card px-4 text-base text-foreground"
          placeholder="Search known words"
          value={query}
          onChangeText={setQuery}
        />
        {matchingEntries.total > matchingEntries.visible.length ? (
          <Text className="px-1 text-xs text-foreground-muted">
            Showing 100 of {matchingEntries.total} matches. Search to narrow the list.
          </Text>
        ) : null}
        {matchingEntries.visible.map((entry) => (
          <View
            key={entry.id}
            className="flex-row items-center gap-3 rounded-[18px] border border-border bg-card px-4 py-3"
          >
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-base text-foreground" numberOfLines={2}>
                {dictionaryEntryLabel(entry)}
              </Text>
              <Text className="text-xs uppercase text-foreground-muted">{entry.source}</Text>
            </View>
            {entry.source === "learned" ? (
              <>
                <Pressable
                  accessibilityLabel={`Edit ${dictionaryEntryLabel(entry)}`}
                  accessibilityRole="button"
                  className="size-10 items-center justify-center rounded-full bg-subtle"
                  disabled={busy}
                  onPress={() => setDraft(draftForEntry(entry))}
                >
                  <SymbolView
                    name="square.and.pencil"
                    size={15}
                    tintColorClassName="accent-icon"
                    type="monochrome"
                  />
                </Pressable>
                <Pressable
                  accessibilityLabel={`Remove ${dictionaryEntryLabel(entry)}`}
                  accessibilityRole="button"
                  className="size-10 items-center justify-center rounded-full bg-subtle"
                  disabled={busy}
                  onPress={() =>
                    Alert.alert("Remove learned entry?", dictionaryEntryLabel(entry), [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Remove",
                        style: "destructive",
                        onPress: () => runUiAction(() => props.onDeleteEntry(entry.id)),
                      },
                    ])
                  }
                >
                  <SymbolView
                    name="trash"
                    size={15}
                    tintColorClassName="accent-danger-foreground"
                    type="monochrome"
                  />
                </Pressable>
              </>
            ) : (
              <Text className="text-xs text-foreground-muted">Synced</Text>
            )}
          </View>
        ))}
        {matchingEntries.total === 0 ? (
          <Text className="py-8 text-center text-sm text-foreground-muted">
            {query.trim()
              ? "No known words match this search."
              : "No known words yet. Teach a transcript or add one here."}
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

export const VoiceSidecarContent = memo(function VoiceSidecarContent(
  props: VoiceSidecarContentProps,
) {
  const [page, setPage] = useState<SidecarPage>("road");
  const activePlaybackRef = useRef<(() => void) | null>(null);
  const playbackCoordinator = useMemo<VoiceSidecarPlaybackCoordinator>(
    () => ({
      claim: (stop) => {
        if (activePlaybackRef.current === stop) return;
        activePlaybackRef.current?.();
        activePlaybackRef.current = stop;
      },
      release: (stop) => {
        if (activePlaybackRef.current === stop) activePlaybackRef.current = null;
      },
      stopActive: () => {
        const stop = activePlaybackRef.current;
        activePlaybackRef.current = null;
        stop?.();
      },
    }),
    [],
  );
  const body = useMemo(() => {
    switch (page) {
      case "road":
        return <RoadView {...props} playbackCoordinator={playbackCoordinator} />;
      case "history":
        return <HistoryView {...props} playbackCoordinator={playbackCoordinator} />;
      case "dictionary":
        return <DictionaryView {...props} playbackCoordinator={playbackCoordinator} />;
    }
  }, [page, playbackCoordinator, props]);

  return (
    // collapsable={false} keeps this wrapper in the native tree. If it gets
    // flattened, RNS's formSheet scroll-view frame correction re-frames the
    // page ScrollView over the header whenever the sheet re-lays-out (e.g. on
    // the detent change when scrolling expands the sheet).
    <View collapsable={false} className="flex-1 bg-sheet">
      <SidecarHeader page={page} onClose={props.onClose} onChangePage={setPage} />
      {props.error ? (
        <View className="border-b border-danger-border bg-danger px-4 py-2">
          <Text className="text-sm text-danger-foreground">{props.error}</Text>
        </View>
      ) : null}
      {body}
    </View>
  );
});
