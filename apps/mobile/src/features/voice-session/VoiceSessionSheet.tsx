import { useNavigation } from "@react-navigation/native";
import type {
  EnvironmentId,
  VoiceConfirmAction,
  VoiceConfirmRequest,
  VoiceNotice,
  VoiceNoticeKind,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useCallback, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  hangUpVoiceSession,
  removeVoiceSessionConfirm,
  startVoiceSession,
  toggleVoiceSessionMute,
  useVoiceSession,
  voiceSessionRespondCommand,
} from "./voiceSessionController";
import { isVoiceSessionActive, type VoiceSessionState } from "./voiceSessionState";

/** Title, icon and body text for the session's current status. */
export function voiceSessionPresentation(state: VoiceSessionState): {
  readonly icon: AppSymbolName;
  readonly title: string;
  readonly body: string;
} {
  switch (state.status) {
    case "idle":
    case "connecting":
      return { icon: "waveform", title: "Connecting", body: "Briefing the orchestrator." };
    case "reconnecting":
      return {
        icon: "waveform",
        title: "Reconnecting",
        body: state.message ?? "The call dropped. Opening a new connection.",
      };
    case "live":
      return {
        icon: state.muted ? "mic.slash" : "waveform",
        title: state.muted ? "Muted" : "Live",
        body:
          state.transcript?.text ??
          "Ask about your threads, or have it start or steer one. It speaks up when something needs you.",
      };
    case "microphone-denied":
      return {
        icon: "mic.slash",
        title: "Microphone access is off",
        body: "Allow microphone access for T3 Code in Settings to talk with the orchestrator.",
      };
    case "failed":
      return {
        icon: "exclamationmark.triangle",
        title: "Call failed",
        body: state.message ?? "The voice session stopped unexpectedly.",
      };
    case "ended":
      return { icon: "phone.down.fill", title: "Call ended", body: state.message ?? "" };
  }
}

const NOTICE_ICONS: Record<VoiceNoticeKind, AppSymbolName> = {
  approval: "exclamationmark.circle",
  failed: "exclamationmark.triangle",
  input: "text.bubble",
  completed: "checkmark.circle",
};

const NOTICE_LABELS: Record<VoiceNoticeKind, string> = {
  approval: "Needs approval",
  failed: "Failed",
  input: "Needs input",
  completed: "Finished",
};

const CONFIRM_LABELS: Record<VoiceConfirmAction, string> = {
  launch: "Start a thread",
  interrupt: "Interrupt a run",
  runtime_approval: "Approve a tool call",
};

function CallButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly tone: "danger" | "neutral";
  readonly selected?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <View className="items-center gap-2">
      <Pressable
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={props.selected === undefined ? undefined : { selected: props.selected }}
        className={cn(
          "size-[64px] items-center justify-center rounded-full active:opacity-70",
          props.tone === "danger" ? "border border-danger-border bg-danger" : "bg-subtle-strong",
        )}
        onPress={props.onPress}
      >
        <SymbolView
          name={props.icon}
          size={26}
          weight="semibold"
          tintColorClassName={
            props.tone === "danger" ? "accent-danger-foreground" : "accent-foreground"
          }
          type="monochrome"
        />
      </Pressable>
      <Text className="text-xs font-t3-medium text-foreground-muted">{props.label}</Text>
    </View>
  );
}

/** An action the orchestrator is holding until the user taps Approve or Deny. */
function ConfirmCard(props: {
  readonly environmentId: EnvironmentId;
  readonly request: VoiceConfirmRequest;
}) {
  const respond = useAtomCommand(voiceSessionRespondCommand, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { environmentId, request } = props;

  const answer = async (approved: boolean) => {
    void Haptics.selectionAsync();
    setBusy(true);
    setError(null);
    const result = await respond({ environmentId, input: { requestId: request.id, approved } });
    setBusy(false);
    if (result._tag === "Success") {
      // A late answer to an expired request has nothing left to act on.
      removeVoiceSessionConfirm(request.id);
      return;
    }
    setError("Could not send your answer. Try again.");
  };

  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-4">
      <View className="gap-1">
        <Text className="text-xs font-t3-bold tracking-[0.5px] uppercase text-foreground-muted">
          {CONFIRM_LABELS[request.action]}
        </Text>
        <Text className="text-base font-t3-bold text-foreground">{request.title}</Text>
        {request.detail.length > 0 ? (
          <Text className="text-sm leading-normal text-foreground-muted" numberOfLines={6}>
            {request.detail}
          </Text>
        ) : null}
        {error !== null ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
      </View>
      <View className="flex-row gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Deny: ${request.title}`}
          disabled={busy}
          className={cn(
            "min-h-11 flex-1 items-center justify-center rounded-full border border-border bg-card px-4 active:opacity-70",
            busy && "opacity-50",
          )}
          onPress={() => void answer(false)}
        >
          <Text className="font-t3-bold text-sm text-foreground">Deny</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Approve: ${request.title}`}
          disabled={busy}
          className={cn(
            "min-h-11 flex-1 items-center justify-center rounded-full bg-primary px-4 active:opacity-70",
            busy && "opacity-50",
          )}
          onPress={() => void answer(true)}
        >
          <Text className="font-t3-bold text-sm text-primary-foreground">Approve</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Something that happened in a thread. Tapping it opens that thread. */
function NoticeCard(props: { readonly notice: VoiceNotice; readonly onPress: () => void }) {
  const { notice } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens the thread"
      className="min-w-0 flex-row items-start gap-3 rounded-2xl border border-border bg-card p-3 active:bg-subtle"
      onPress={props.onPress}
    >
      <SymbolView
        name={NOTICE_ICONS[notice.kind]}
        size={20}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-xs font-t3-medium text-foreground-muted" numberOfLines={1}>
          {NOTICE_LABELS[notice.kind]} · {notice.threadTitle}
        </Text>
        <Text className="text-sm leading-normal text-foreground" numberOfLines={3}>
          {notice.text}
        </Text>
      </View>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );
}

/**
 * The full view of the orchestrator session: status, the live line, confirm
 * cards and notices. Closing the sheet keeps the call going; the mini-bar
 * brings it back.
 */
export function VoiceSessionSheet() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const state = useVoiceSession();
  const active = isVoiceSessionActive(state);
  const view = voiceSessionPresentation(state);
  const { environmentId } = state;

  const close = useCallback(() => navigation.goBack(), [navigation]);
  const hangUp = useCallback(() => {
    void Haptics.selectionAsync();
    hangUpVoiceSession();
    navigation.goBack();
  }, [navigation]);
  const toggleMute = useCallback(() => {
    void Haptics.selectionAsync();
    toggleVoiceSessionMute();
  }, []);
  const openThread = useCallback(
    (notice: VoiceNotice) => {
      if (environmentId === null) return;
      navigation.goBack();
      navigation.navigate("Thread", {
        environmentId: String(environmentId),
        threadId: String(notice.threadId),
      });
    },
    [environmentId, navigation],
  );
  const restart = useCallback(() => {
    if (environmentId === null) return;
    void Haptics.selectionAsync();
    startVoiceSession({ environmentId, focusThreadId: null });
  }, [environmentId]);

  return (
    <View
      collapsable={false}
      className="flex-1 bg-sheet"
      style={{
        paddingTop: Platform.OS === "android" ? insets.top + 16 : 24,
        paddingBottom: Math.max(insets.bottom, 16) + 16,
      }}
    >
      <Text className="text-center text-xs font-t3-bold tracking-[1px] uppercase text-foreground-muted">
        Orchestrator
      </Text>

      <View className="items-center gap-3 px-6 pt-6 pb-4">
        <View className="size-[72px] items-center justify-center rounded-full bg-subtle">
          <SymbolView
            name={view.icon}
            size={32}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        </View>
        <Text
          accessibilityLiveRegion="polite"
          className="text-center text-2xl font-t3-bold text-foreground"
        >
          {view.title}
        </Text>
        {view.body.length > 0 ? (
          <Text
            className="text-center text-base leading-normal text-foreground-muted"
            numberOfLines={5}
          >
            {view.body}
          </Text>
        ) : null}
      </View>

      <ScrollView className="flex-1" contentContainerClassName="gap-3 px-4 pb-4">
        {environmentId !== null
          ? state.confirms.map((request) => (
              <ConfirmCard key={request.id} environmentId={environmentId} request={request} />
            ))
          : null}
        {state.notices.map((notice) => (
          <NoticeCard key={notice.id} notice={notice} onPress={() => openThread(notice)} />
        ))}
      </ScrollView>

      {active ? (
        <View className="flex-row items-start justify-center gap-12 px-6 pt-2">
          {state.status === "live" ? (
            <CallButton
              accessibilityLabel={state.muted ? "Unmute microphone" : "Mute microphone"}
              icon={state.muted ? "mic.slash" : "mic"}
              label={state.muted ? "Unmute" : "Mute"}
              tone="neutral"
              selected={state.muted}
              onPress={toggleMute}
            />
          ) : null}
          <CallButton
            accessibilityLabel="Hang up"
            icon="phone.down.fill"
            label="Hang up"
            tone="danger"
            onPress={hangUp}
          />
        </View>
      ) : (
        <View className="gap-3 px-6 pt-2">
          {state.status === "microphone-denied" ? (
            <Pressable
              accessibilityRole="button"
              className="min-h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-70"
              onPress={() => void Linking.openSettings()}
            >
              <Text className="font-t3-bold text-sm text-primary-foreground">Open Settings</Text>
            </Pressable>
          ) : state.status === "failed" && environmentId !== null ? (
            <Pressable
              accessibilityRole="button"
              className="min-h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-70"
              onPress={restart}
            >
              <Text className="font-t3-bold text-sm text-primary-foreground">Try again</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            className="min-h-12 items-center justify-center rounded-full border border-border bg-card px-5 active:opacity-70"
            onPress={close}
          >
            <Text className="font-t3-bold text-sm text-foreground">Close</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
