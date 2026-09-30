import * as Haptics from "expo-haptics";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import {
  hangUpVoiceSession,
  toggleVoiceSessionMute,
  useVoiceSession,
} from "./voiceSessionController";
import { isVoiceSessionActive } from "./voiceSessionState";

/**
 * A small capsule under the status bar while the orchestrator session runs,
 * on every screen. Tapping it opens the full sheet; mute and hang up work in
 * place. Hidden while the sheet itself is open.
 */
export function VoiceSessionMiniBar(props: {
  readonly sheetOpen: boolean;
  readonly onOpenSheet: () => void;
}) {
  const insets = useSafeAreaInsets();
  const state = useVoiceSession();
  if (props.sheetOpen || !isVoiceSessionActive(state)) return null;
  const live = state.status === "live";
  const label = live
    ? state.muted
      ? "Muted"
      : "Live"
    : state.status === "reconnecting"
      ? "Reconnecting"
      : "Connecting";

  return (
    <View
      pointerEvents="box-none"
      className="absolute left-0 right-0 items-center"
      style={{ top: insets.top + 4 }}
    >
      <View className="flex-row items-center gap-1 rounded-full border border-border bg-card py-1 pl-3 pr-1 shadow-sm">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}. Open the voice session`}
          className="flex-row items-center gap-2 py-1 pr-1 active:opacity-70"
          onPress={props.onOpenSheet}
        >
          <View className={cn("size-2 rounded-full", live ? "bg-primary" : "bg-subtle-strong")} />
          <Text className="text-sm font-t3-bold text-foreground">{label}</Text>
        </Pressable>
        {live ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={state.muted ? "Unmute microphone" : "Mute microphone"}
            accessibilityState={{ selected: state.muted }}
            className="size-8 items-center justify-center rounded-full bg-subtle-strong active:opacity-70"
            onPress={() => {
              void Haptics.selectionAsync();
              toggleVoiceSessionMute();
            }}
          >
            <SymbolView
              name={state.muted ? "mic.slash" : "mic"}
              size={16}
              weight="semibold"
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hang up"
          className="size-8 items-center justify-center rounded-full border border-danger-border bg-danger active:opacity-70"
          onPress={() => {
            void Haptics.selectionAsync();
            hangUpVoiceSession();
          }}
        >
          <SymbolView
            name="phone.down.fill"
            size={16}
            weight="semibold"
            tintColorClassName="accent-danger-foreground"
            type="monochrome"
          />
        </Pressable>
      </View>
    </View>
  );
}
