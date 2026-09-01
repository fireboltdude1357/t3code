import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ignoreReleasedNativeObject } from "./releasedNativeObject";

async function prepareForegroundPlayback(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: false,
    interruptionMode: "doNotMix",
    playsInSilentMode: true,
    shouldPlayInBackground: false,
  });
}

export interface VoiceSidecarPlaybackCoordinator {
  readonly claim: (stop: () => void) => void;
  readonly release: (stop: () => void) => void;
  readonly stopActive: () => void;
}

export const VoiceSidecarAudioPlayer = memo(function VoiceSidecarAudioPlayer(props: {
  readonly url: string | null;
  readonly label?: string;
  readonly autoPlay?: boolean;
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly coordinator: VoiceSidecarPlaybackCoordinator;
  readonly onAutoPlayConsumed?: () => void;
}) {
  const player = useAudioPlayer(props.url, { downloadFirst: true, updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const autoPlayedUrlRef = useRef<string | null>(null);
  const previousUrlRef = useRef(props.url);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const stop = useCallback(() => {
    // This runs from the unmount cleanup and from the coordinator, both of
    // which can outlive the native player.
    ignoreReleasedNativeObject(() => player.pause());
    props.coordinator.release(stop);
  }, [player, props.coordinator]);

  const play = useCallback(async () => {
    if (!props.url || props.disabled) return;
    props.coordinator.claim(stop);
    setPlaybackError(null);
    try {
      await prepareForegroundPlayback();
      if (status.didJustFinish || status.currentTime >= status.duration) {
        await player.seekTo(0);
      }
      player.play();
    } catch (error) {
      stop();
      setPlaybackError(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not play this audio.",
      );
    }
  }, [
    player,
    props.coordinator,
    props.disabled,
    props.url,
    status.currentTime,
    status.didJustFinish,
    status.duration,
    stop,
  ]);

  useEffect(() => {
    if (!props.autoPlay || props.disabled || !props.url || autoPlayedUrlRef.current === props.url) {
      return;
    }
    autoPlayedUrlRef.current = props.url;
    void play().then(props.onAutoPlayConsumed);
  }, [play, props.autoPlay, props.disabled, props.onAutoPlayConsumed, props.url]);

  useEffect(() => {
    if (props.disabled) stop();
  }, [props.disabled, stop]);

  useEffect(() => {
    if (status.didJustFinish) props.coordinator.release(stop);
  }, [props.coordinator, status.didJustFinish, stop]);

  useEffect(() => {
    if (previousUrlRef.current !== props.url) {
      stop();
      previousUrlRef.current = props.url;
      setPlaybackError(null);
    }
  }, [props.url, stop]);

  useEffect(
    () => () => {
      stop();
    },
    [stop],
  );

  if (!props.url) {
    return null;
  }

  const elapsed = Math.max(0, Math.floor(status.currentTime));
  const duration = Math.max(0, Math.floor(status.duration));
  const timeLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")} / ${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")}`;

  return (
    <View
      className={
        props.compact
          ? "flex-row items-center gap-2"
          : "flex-row items-center gap-3 rounded-[20px] border border-border bg-card px-3 py-2"
      }
    >
      <Pressable
        accessibilityLabel={status.playing ? "Pause audio" : "Play audio"}
        accessibilityRole="button"
        className="size-10 items-center justify-center rounded-full bg-subtle active:opacity-70 disabled:opacity-40"
        disabled={props.disabled}
        onPress={() => {
          if (status.playing) {
            stop();
          } else {
            void play();
          }
        }}
      >
        {!status.isLoaded ? (
          <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
        ) : (
          <SymbolView
            name={status.playing ? "stop.fill" : "play"}
            size={15}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        )}
      </Pressable>
      <View className="min-w-0 flex-1">
        {props.label ? (
          <Text className="font-t3-bold text-sm text-foreground" numberOfLines={1}>
            {props.label}
          </Text>
        ) : null}
        <Text className="text-xs tabular-nums text-foreground-muted">{timeLabel}</Text>
        {playbackError ? (
          <Text className="text-xs text-danger-foreground">{playbackError}</Text>
        ) : null}
      </View>
    </View>
  );
});
