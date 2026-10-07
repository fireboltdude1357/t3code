import { setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";

// The same audio session handling as dictation, kept here so the memo does not
// depend on the dictation controller's internals.

/** Ends the recording audio session so audio the memo interrupted can resume. */
export async function releaseMemoRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Expo does not deactivate AVAudioSession when recording stops or its
    // category changes. Explicit deactivation resumes interrupted app audio.
    await setIsAudioActiveAsync(false);
  }
}

/** Puts the audio session into recording mode. Pair with `releaseMemoRecordingAudio`. */
export async function configureMemoRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    try {
      await releaseMemoRecordingAudio();
    } catch {
      // Keep the setup error. No recorder has started yet.
    }
    throw error;
  }
}

/**
 * Leaves recording mode before a reply plays, so iOS uses the speaker or car
 * Bluetooth instead of the earpiece. The player releases the session when it
 * finishes, which resumes whatever the memo interrupted.
 */
export async function configureMemoPlaybackAudio(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: false,
    interruptionMode: "doNotMix",
    playsInSilentMode: true,
    shouldPlayInBackground: false,
  });
}
