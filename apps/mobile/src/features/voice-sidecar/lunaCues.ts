import { useAudioPlayer, type AudioPlayer } from "expo-audio";
import { useCallback, useEffect } from "react";

import { ignoreReleasedNativeObject } from "./releasedNativeObject";
import { prepareForegroundPlayback } from "./voiceSidecarAudioMode";

// Waiting music: "Backbay Lounge" by Kevin MacLeod (incompetech.com),
// licensed under Creative Commons: By Attribution 4.0
// (https://creativecommons.org/licenses/by/4.0/). Trimmed to 2.5 minutes,
// mono AAC. It picks up where it left off between waits rather than
// restarting, and fades out when Luna starts speaking.
const WAITING_MUSIC = require("../../../assets/sounds/luna-waiting.m4a");
// Falling two-note tone (24 kHz mono PCM).
const ERROR_SOUND = require("../../../assets/sounds/luna-error.wav");

const MUSIC_VOLUME = 0.35;
const FADE_IN_MS = 600;
const FADE_OUT_MS = 900;
const FADE_STEP_MS = 40;

/**
 * Audible feedback for eyes-off use: instrumental jazz while Luna is
 * transcribing, thinking, or synthesizing, and a falling two-note cue whenever
 * `errorKey` changes to a new message. Returns `playError` for errors that
 * live outside the sheet's error banner (the recorder).
 */
export function useLunaCues(input: {
  readonly processing: boolean;
  readonly errorKey: string | null;
}) {
  const musicPlayer = useAudioPlayer(WAITING_MUSIC);
  const errorPlayer = useAudioPlayer(ERROR_SOUND);

  useEffect(() => {
    musicPlayer.loop = true;
    musicPlayer.volume = 0;
  }, [musicPlayer]);
  useEffect(() => {
    errorPlayer.loop = false;
    errorPlayer.volume = 0.7;
  }, [errorPlayer]);

  useEffect(() => {
    if (!input.processing) return;
    let cancelled = false;
    let stopFade = () => undefined as void;
    prepareForegroundPlayback()
      .then(() => {
        if (cancelled) return;
        musicPlayer.play();
        stopFade = fadeVolume(musicPlayer, MUSIC_VOLUME, FADE_IN_MS);
      })
      .catch((error: unknown) => {
        console.warn("[voice-sidecar] could not start the waiting music", error);
      });
    return () => {
      cancelled = true;
      stopFade();
      // Fade rather than cut: the answer starts right after this. The player
      // can already be released when the sheet is closing.
      stopFade = fadeVolume(musicPlayer, 0, FADE_OUT_MS, () => {
        ignoreReleasedNativeObject(() => musicPlayer.pause());
      });
    };
  }, [input.processing, musicPlayer]);

  const playError = useCallback(() => {
    prepareForegroundPlayback()
      .then(async () => {
        await errorPlayer.seekTo(0);
        errorPlayer.play();
      })
      .catch((error: unknown) => {
        console.warn("[voice-sidecar] could not play the error cue", error);
      });
  }, [errorPlayer]);

  useEffect(() => {
    if (input.errorKey !== null) playError();
  }, [input.errorKey, playError]);

  return { playError };
}

/** Ramps the player volume on a timer; returns a canceller. Timer-based, so nothing repaints. */
function fadeVolume(
  player: AudioPlayer,
  target: number,
  durationMs: number,
  onDone?: () => void,
): () => void {
  const start = ignoreReleasedNativeObject(() => player.volume) ?? target;
  const steps = Math.max(1, Math.round(durationMs / FADE_STEP_MS));
  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    const volume = start + ((target - start) * step) / steps;
    const alive =
      ignoreReleasedNativeObject(() => {
        player.volume = volume;
        return true;
      }) === true;
    if (step >= steps || !alive) {
      clearInterval(timer);
      onDone?.();
    }
  }, FADE_STEP_MS);
  return () => clearInterval(timer);
}
