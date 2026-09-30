import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { requestRecordingPermissionsAsync } from "expo-audio";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Linking, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { openVoiceCallPeer, type VoiceCallPeer } from "./voiceCallPeer";
import { INITIAL_VOICE_CALL_STATE, voiceCallReducer, type VoiceCallState } from "./voiceCallState";

type VoiceCallSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

const SENT_DISMISS_DELAY_MS = 1_500;

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function presentation(state: VoiceCallState): {
  readonly icon: AppSymbolName;
  readonly title: string;
  readonly body: string;
} {
  switch (state.phase) {
    case "connecting":
      return {
        icon: "waveform",
        title: "Connecting",
        body: "Starting a Codex voice fork of this thread.",
      };
    case "live":
      return {
        icon: state.muted ? "mic.slash" : "waveform",
        title: state.muted ? "Muted" : "Live",
        body:
          state.transcript?.text ??
          "Talk it through. Ask Codex to send a message to the main thread when you are ready.",
      };
    case "microphone-denied":
      return {
        icon: "mic.slash",
        title: "Microphone access is off",
        body: "Allow microphone access for T3 Code in Settings to talk with Codex.",
      };
    case "ended":
      switch (state.reason) {
        case "sent":
          return {
            icon: "checkmark.circle",
            title: "Sent to the main thread",
            body: "The voice fork has been archived.",
          };
        case "error":
          return {
            icon: "exclamationmark.triangle",
            title: "Call failed",
            body: state.message ?? "The voice call stopped unexpectedly.",
          };
        case "closed":
        case "hung_up":
          return { icon: "phone.down.fill", title: "Call ended", body: state.message ?? "" };
      }
  }
}

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
          "size-[72px] items-center justify-center rounded-full active:opacity-70",
          props.tone === "danger" ? "border border-danger-border bg-danger" : "bg-subtle-strong",
        )}
        onPress={props.onPress}
      >
        <SymbolView
          name={props.icon}
          size={28}
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

/**
 * Realtime voice call with a Codex fork of the thread. The phone owns the
 * microphone and speaker over WebRTC; the server only brokers the offer and
 * reports how the call ended. Leaving the sheet hangs up.
 */
export function VoiceCallSheet(props: VoiceCallSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, threadId } = props.route.params;
  const [state, dispatch] = useReducer(voiceCallReducer, INITIAL_VOICE_CALL_STATE);
  const [offerSdp, setOfferSdp] = useState<string | null>(null);
  const peerRef = useRef<VoiceCallPeer | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const permission = await requestRecordingPermissionsAsync();
      if (!active) return;
      if (!permission.granted) {
        dispatch({ type: "microphone-denied" });
        return;
      }
      const peer = await openVoiceCallPeer({
        onRealtimeEvent: (event) => dispatch({ type: "realtime", event }),
        onConnectionFailed: () =>
          dispatch({ type: "failed", message: "The call audio connection dropped." }),
      });
      if (!active) {
        peer.close();
        return;
      }
      peerRef.current = peer;
      setOfferSdp(peer.offerSdp);
    })().catch((error: unknown) => {
      dispatch({ type: "failed", message: messageOf(error, "Could not start the microphone.") });
    });
    return () => {
      active = false;
      peerRef.current?.close();
      peerRef.current = null;
    };
  }, []);

  const callAtom = useMemo(
    () =>
      offerSdp === null
        ? null
        : serverEnvironment.voiceCall({
            environmentId: EnvironmentId.make(environmentId),
            input: { sourceThreadId: ThreadId.make(threadId), sdpOffer: offerSdp },
          }),
    [environmentId, offerSdp, threadId],
  );
  const callActive = state.phase === "connecting" || state.phase === "live";
  // Dropping the atom interrupts the stream, which is how the server learns we hung up.
  const call = useEnvironmentQuery(callActive ? callAtom : null);
  const serverEvent = call.data;

  useEffect(() => {
    if (serverEvent === null) return;
    dispatch({ type: "server", event: serverEvent });
    if (serverEvent.type === "answer") {
      peerRef.current?.acceptAnswer(serverEvent.sdpAnswer).catch((error: unknown) => {
        dispatch({
          type: "failed",
          message: messageOf(error, "Could not connect the call audio."),
        });
      });
    }
  }, [serverEvent]);

  useEffect(() => {
    if (call.error !== null) dispatch({ type: "failed", message: call.error });
  }, [call.error]);

  const streamCompleted = serverEvent !== null && !call.isPending && call.error === null;
  useEffect(() => {
    if (streamCompleted) dispatch({ type: "stream-completed" });
  }, [streamCompleted]);

  const muted = state.phase === "live" && state.muted;
  useEffect(() => {
    peerRef.current?.setMuted(muted);
  }, [muted]);

  const endReason = state.phase === "ended" ? state.reason : null;
  useEffect(() => {
    if (endReason === null) return;
    peerRef.current?.close();
    if (endReason !== "sent") return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const timer = setTimeout(() => navigation.goBack(), SENT_DISMISS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [endReason, navigation]);

  const close = useCallback(() => navigation.goBack(), [navigation]);
  const hangUp = useCallback(() => {
    void Haptics.selectionAsync();
    navigation.goBack();
  }, [navigation]);
  const toggleMute = useCallback(() => {
    void Haptics.selectionAsync();
    dispatch({ type: "toggle-mute" });
  }, []);

  const view = presentation(state);

  return (
    <View
      collapsable={false}
      className="flex-1 bg-sheet px-6"
      style={{
        paddingTop: Platform.OS === "android" ? insets.top + 16 : 24,
        paddingBottom: Math.max(insets.bottom, 16) + 16,
      }}
    >
      <Text className="text-center text-xs font-t3-bold tracking-[1px] uppercase text-foreground-muted">
        Codex voice
      </Text>

      <View className="flex-1 items-center justify-center gap-4">
        <View className="size-[96px] items-center justify-center rounded-full bg-subtle">
          <SymbolView
            name={view.icon}
            size={40}
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
            numberOfLines={8}
          >
            {view.body}
          </Text>
        ) : null}
      </View>

      {callActive ? (
        <View className="flex-row items-start justify-center gap-12">
          {state.phase === "live" ? (
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
        <View className="gap-3">
          {state.phase === "microphone-denied" ? (
            <Pressable
              accessibilityRole="button"
              className="min-h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-70"
              onPress={() => void Linking.openSettings()}
            >
              <Text className="font-t3-bold text-sm text-primary-foreground">Open Settings</Text>
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
