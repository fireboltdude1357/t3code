import { useAudioPlayer, type AudioPlayer } from "expo-audio";
import { useCallback, useEffect } from "react";

import { ignoreReleasedNativeObject } from "./releasedNativeObject";
import { prepareForegroundPlayback } from "./voiceSidecarAudioMode";

// Short generated tones (24 kHz mono PCM). The processing loop ends in
// silence so it repeats without a seam.
const PROCESSING_SOUND = require("../../../assets/sounds/luna-processing.wav");
const ERROR_SOUND = require("../../../assets/sounds/luna-error.wav");

/**
 * Audible feedback for eyes-off use: a soft loop while Luna is transcribing,
 * thinking, or synthesizing, and a falling two-note cue whenever `errorKey`
 * changes to a new message. Returns `playError` for errors that live outside
 * the sheet's error banner (the recorder).
 */
export function useLunaCues(input: {
  readonly processing: boolean;
  readonly errorKey: string | null;
}) {
  const processingPlayer = useAudioPlayer(PROCESSING_SOUND);
  const errorPlayer = useAudioPlayer(ERROR_SOUND);

  useEffect(() => configure(processingPlayer, { loop: true, volume: 0.5 }), [processingPlayer]);
  useEffect(() => configure(errorPlayer, { loop: false, volume: 0.7 }), [errorPlayer]);

  useEffect(() => {
    if (!input.processing) return;
    let cancelled = false;
    prepareForegroundPlayback()
      .then(() => {
        if (!cancelled) processingPlayer.play();
      })
      .catch((error: unknown) => {
        console.warn("[voice-sidecar] could not start the processing cue", error);
      });
    return () => {
      cancelled = true;
      // The player can already be released when the sheet is closing.
      ignoreReleasedNativeObject(() => {
        processingPlayer.pause();
        void processingPlayer.seekTo(0);
      });
    };
  }, [input.processing, processingPlayer]);

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

function configure(
  player: AudioPlayer,
  options: { readonly loop: boolean; readonly volume: number },
) {
  player.loop = options.loop;
  player.volume = options.volume;
}
