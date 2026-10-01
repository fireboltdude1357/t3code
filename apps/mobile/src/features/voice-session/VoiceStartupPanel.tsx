import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Animated, AppState, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { STARTUP_LABELS, type VoiceSessionState } from "./voiceSessionState";

const STAGES = [
  "microphone",
  "preparing-audio",
  "contacting-server",
  "preparing-session",
  "briefing",
  "starting-realtime",
  "connecting-audio",
  "connected",
] as const;
const AUDIO_CHOICES = [
  { value: "ringing", label: "Ringing" },
  { value: "jazz", label: "Jazz" },
  { value: "silence", label: "Silence" },
] as const;

/** Moves only when startup advances. No animation runs while a step is waiting. */
function StartupProgress({ step, total }: { readonly step: number; readonly total: number }) {
  const [progress] = useState(() => new Animated.Value(step / total));
  const [reducedMotion, setReducedMotion] = useState(true);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReducedMotion(value);
      })
      .catch(() => {
        /* Keep progress static if the system preference is unavailable. */
      });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotion,
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (reducedMotion) {
      progress.setValue(step / total);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: step / total,
      duration: 180,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, reducedMotion, step, total]);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Call startup"
      accessibilityValue={{ min: 0, max: total, now: step, text: `Step ${step} of ${total}` }}
      className="h-1.5 overflow-hidden rounded-full bg-subtle-strong"
    >
      <Animated.View
        className="h-full rounded-full bg-primary"
        style={{ transformOrigin: "left center", transform: [{ scaleX: progress }] }}
      />
    </View>
  );
}

export function VoiceStartupPanel({ state }: { readonly state: VoiceSessionState }) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const choice =
    preferences._tag === "Success" ? (preferences.value.voiceStartupAudio ?? "ringing") : "silence";
  const waiting = state.status === "connecting" || state.status === "reconnecting";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!waiting) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (AppState.currentState === "active") {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), 1000);
      }
    };
    sync();
    const subscription = AppState.addEventListener("change", sync);
    return () => {
      if (timer !== undefined) clearInterval(timer);
      subscription.remove();
    };
  }, [waiting]);
  const reconnectLog = state.startupLog.slice(
    state.startupLog.findLastIndex((entry) => entry.stage === "connected") + 1,
  );
  const startupLog = reconnectLog.length > 0 ? reconnectLog : state.startupLog;
  const latest = startupLog.at(-1);
  const stageIndex = STAGES.findIndex((stage) => stage === latest?.stage);
  const step = stageIndex < 0 ? 1 : stageIndex + 1;
  const startedAt = startupLog[0]?.at ?? now;
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <View className="gap-4 rounded-2xl border border-border bg-card p-4">
      {waiting ? (
        <View className="gap-3">
          <View className="flex-row items-center justify-between gap-2">
            <Text
              accessibilityLiveRegion="polite"
              className="flex-1 text-sm font-t3-medium text-foreground"
            >
              {latest ? STARTUP_LABELS[latest.stage] : "Starting the call"}
            </Text>
            <Text className="text-xs text-foreground-muted">{elapsed}s</Text>
          </View>
          <StartupProgress step={step} total={STAGES.length} />
          {elapsed >= 15 ? (
            <Text className="text-xs leading-normal text-foreground-muted">
              Codex is still starting. You can cancel below.
            </Text>
          ) : null}
        </View>
      ) : null}
      <View className="gap-2">
        <Text className="text-xs font-t3-medium text-foreground-muted">Startup audio</Text>
        <View accessibilityRole="radiogroup" className="flex-row gap-2">
          {AUDIO_CHOICES.map((item) => (
            <Pressable
              key={item.value}
              accessibilityRole="radio"
              accessibilityLabel={`${item.label} startup audio`}
              accessibilityState={{ checked: choice === item.value }}
              disabled={preferences._tag !== "Success"}
              onPress={() => save({ voiceStartupAudio: item.value })}
              className={cn(
                "min-h-11 flex-1 items-center justify-center rounded-full border px-3 active:opacity-70",
                choice === item.value ? "border-primary bg-primary" : "border-border bg-subtle",
              )}
            >
              <Text
                className={cn(
                  "text-sm font-t3-medium",
                  choice === item.value ? "text-primary-foreground" : "text-foreground",
                )}
              >
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text className="text-xs text-foreground-muted">
          Saved for your next call. Stops before conversation audio.
        </Text>
      </View>
      <View className="gap-1.5">
        <Text className="text-xs font-t3-medium text-foreground-muted">Startup log</Text>
        {startupLog.map((entry) => (
          <View key={`${entry.attempt}-${entry.stage}-${entry.at}`} className="flex-row gap-3">
            <Text className="w-9 text-xs text-foreground-muted">
              {Math.max(0, (entry.at - startedAt) / 1000).toFixed(1)}s
            </Text>
            <Text selectable className="flex-1 text-xs leading-normal text-foreground-muted">
              {STARTUP_LABELS[entry.stage]}
              {entry.attempt > (startupLog[0]?.attempt ?? 0)
                ? ` · attempt ${entry.attempt - (startupLog[0]?.attempt ?? 0) + 1}`
                : ""}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
