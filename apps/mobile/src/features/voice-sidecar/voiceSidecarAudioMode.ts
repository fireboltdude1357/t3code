import { setAudioModeAsync } from "expo-audio";

/**
 * Switches the audio session from recording back to speaker playback. Every
 * Luna player (answers, cues, history clips) calls this before `play()`.
 */
export async function prepareForegroundPlayback(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: false,
    interruptionMode: "doNotMix",
    playsInSilentMode: true,
    shouldPlayInBackground: false,
  });
}
