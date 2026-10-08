import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { useEffect, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import {
  cancelVoiceMemoRecording,
  closeVoiceMemoSheet,
  replayVoiceMemo,
  resetVoiceMemo,
  retryVoiceMemo,
  sendVoiceMemoRecording,
  startVoiceMemoRecording,
  stopVoiceMemoPlayback,
  useVoiceMemo,
} from "./voiceMemoController";
import {
  VOICE_MEMO_MAX_RECORDING_MS,
  type VoiceMemoStage,
  type VoiceMemoState,
} from "./voiceMemoState";

interface MemoAction {
  readonly label: string;
  readonly onPress: () => void;
}

interface MemoPresentation {
  readonly title: string;
  readonly body: string;
  readonly primary: {
    readonly icon: AppSymbolName;
    readonly label: string;
    /** Null while the memo is busy and a tap would do nothing. */
    readonly onPress: (() => void) | null;
  };
  readonly secondary: MemoAction | null;
}

const FAILED_TITLES: Record<VoiceMemoStage, string> = {
  record: "Could not record",
  submit: "Memo not sent",
  download: "Could not get the reply audio",
  playback: "Could not play the reply",
};

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const RECORD = { icon: "mic", label: "Record", onPress: startVoiceMemoRecording } as const;
const BUSY = { icon: "clock", label: "Working", onPress: null } as const;
const NO_SIGNAL = "No signal, retrying";

/** What the sheet shows and what its big button does in each state. */
function voiceMemoPresentation(state: VoiceMemoState, now: number): MemoPresentation {
  const cancelInFlight = { label: "Cancel", onPress: resetVoiceMemo };
  switch (state.status) {
    case "idle":
      return {
        title: "Voice memo",
        body:
          state.focusThreadId === null
            ? "Tap to record a message for the orchestrator. Tap again to send it."
            : "Tap to record a message about this thread. Tap again to send it.",
        primary: RECORD,
        secondary: null,
      };
    case "starting":
      return {
        title: "Starting the microphone",
        body: "",
        primary: { icon: "mic", label: "Starting", onPress: null },
        secondary: { label: "Cancel", onPress: cancelVoiceMemoRecording },
      };
    case "recording":
      return {
        title: formatElapsed(now - (state.recordingStartedAt ?? now)),
        body: `Tap to send. It sends on its own at ${formatElapsed(VOICE_MEMO_MAX_RECORDING_MS)}.`,
        primary: { icon: "arrow.up", label: "Send", onPress: sendVoiceMemoRecording },
        secondary: { label: "Cancel", onPress: cancelVoiceMemoRecording },
      };
    case "sending":
      return {
        title: state.retrying ? NO_SIGNAL : "Sending…",
        body: state.retrying
          ? "The memo is saved on this phone. It keeps trying for 10 minutes."
          : "",
        primary: BUSY,
        secondary: cancelInFlight,
      };
    case "waiting":
      return {
        title: state.retrying ? NO_SIGNAL : "Waiting for reply…",
        body: state.retrying
          ? "The server already has the memo and will not run it twice."
          : "Replies usually take under a minute.",
        primary: BUSY,
        secondary: cancelInFlight,
      };
    case "downloading":
      return {
        title: state.retrying ? NO_SIGNAL : "Getting the reply…",
        body: "",
        primary: BUSY,
        secondary: cancelInFlight,
      };
    case "playing":
      return {
        title: "Playing the reply",
        body: "Tap to stop and record your next memo.",
        primary: { icon: "mic", label: "Record next", onPress: startVoiceMemoRecording },
        secondary: { label: "Stop", onPress: stopVoiceMemoPlayback },
      };
    case "ready":
      return {
        title: "Reply",
        body: "",
        primary: RECORD,
        secondary: { label: "Replay", onPress: replayVoiceMemo },
      };
    case "failed":
      return {
        title: FAILED_TITLES[state.error?.stage ?? "submit"],
        body: state.error?.message ?? "",
        primary: { icon: "arrow.clockwise", label: "Retry", onPress: retryVoiceMemo },
        secondary: { label: "Start over", onPress: resetVoiceMemo },
      };
    case "microphone-denied":
      return {
        title: "Microphone access is off",
        body: "Allow microphone access for T3 Code in Settings to record memos.",
        primary: {
          icon: "mic.slash",
          label: "Open Settings",
          onPress: () => void Linking.openSettings(),
        },
        secondary: null,
      };
  }
}

/** Re-renders once a second while recording, for the elapsed time. Reads 0:00 until the first tick. */
function useRecordingClock(recording: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  return now;
}

/**
 * Record a message, send it, hear the reply. One big button does the next
 * thing, so it works at a glance while driving. Closing the sheet drops a
 * recording in progress, but a memo already sent keeps going and its reply
 * still plays.
 */
export function VoiceMemoSheet() {
  useKeepAwake("voice-memo");
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const state = useVoiceMemo();
  const now = useRecordingClock(state.status === "recording");
  const view = voiceMemoPresentation(state, now);
  const { primary, secondary } = view;

  useEffect(() => closeVoiceMemoSheet, []);

  const pressPrimary = () => {
    if (primary.onPress === null) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    primary.onPress();
  };
  const pressSecondary = (action: MemoAction) => {
    void Haptics.selectionAsync();
    action.onPress();
  };

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
        Voice memo
      </Text>

      <View className="items-center gap-2 px-6 pt-6">
        <Text
          accessibilityLiveRegion="polite"
          className="text-center text-2xl font-t3-bold text-foreground"
        >
          {view.title}
        </Text>
        {view.body.length > 0 ? (
          <Text className="text-center text-base leading-normal text-foreground-muted">
            {view.body}
          </Text>
        ) : null}
      </View>

      <View className="items-center gap-3 py-8">
        <Pressable
          accessibilityLabel={primary.label}
          accessibilityRole="button"
          accessibilityState={{ disabled: primary.onPress === null }}
          disabled={primary.onPress === null}
          className={cn(
            "size-[120px] items-center justify-center rounded-full active:opacity-70",
            primary.onPress === null ? "bg-subtle-strong" : "bg-primary",
          )}
          onPress={pressPrimary}
        >
          <SymbolView
            name={primary.icon}
            size={44}
            weight="semibold"
            tintColorClassName={
              primary.onPress === null ? "accent-icon-muted" : "accent-primary-foreground"
            }
            type="monochrome"
          />
        </Pressable>
        <Text className="text-sm font-t3-medium text-foreground-muted">{primary.label}</Text>
      </View>

      {secondary !== null ? (
        <View className="items-center px-6">
          <Pressable
            accessibilityRole="button"
            className="min-h-11 min-w-32 items-center justify-center rounded-full border border-border bg-card px-5 active:opacity-70"
            onPress={() => pressSecondary(secondary)}
          >
            <Text className="font-t3-bold text-sm text-foreground">{secondary.label}</Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView className="flex-1" contentContainerClassName="gap-3 px-4 pt-6 pb-4">
        {state.reply !== null ? (
          <>
            {state.reply.transcript.length > 0 ? (
              <View className="gap-1 rounded-2xl border border-border bg-card p-4">
                <Text className="text-xs font-t3-bold tracking-[0.5px] uppercase text-foreground-muted">
                  You said
                </Text>
                <Text className="text-sm leading-normal text-foreground">
                  {state.reply.transcript}
                </Text>
              </View>
            ) : null}
            <View className="gap-1 rounded-2xl border border-border bg-card p-4">
              <Text className="text-xs font-t3-bold tracking-[0.5px] uppercase text-foreground-muted">
                Reply
              </Text>
              <Text className="text-base leading-normal text-foreground">{state.reply.reply}</Text>
            </View>
          </>
        ) : null}
      </ScrollView>

      <View className="px-6 pt-2">
        <Pressable
          accessibilityRole="button"
          className="min-h-12 items-center justify-center rounded-full border border-border bg-card px-5 active:opacity-70"
          onPress={() => navigation.goBack()}
        >
          <Text className="font-t3-bold text-sm text-foreground">Close</Text>
        </Pressable>
      </View>
    </View>
  );
}
