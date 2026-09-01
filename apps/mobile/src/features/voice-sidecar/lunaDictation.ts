import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/**
 * Bridge to the LunaDictation native module (modules/luna-dictation), which
 * runs Apple's on-device DictationTranscriber with contextual-string biasing.
 * Resolves to null on Android, on iOS below 26, and in binaries built without
 * the module, so callers fall back to host-side transcription.
 */

interface LunaDictationNativeModule {
  isAvailable(locale: string): Promise<boolean>;
  transcribe(uri: string, locale: string, contextualStrings: readonly string[]): Promise<string>;
}

const native =
  Platform.OS === "ios"
    ? requireOptionalNativeModule<LunaDictationNativeModule>("LunaDictation")
    : null;

function deviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

let availability: Promise<boolean> | null = null;

/** Cached per app run; the OS version and device language do not change mid-run. */
export function localDictationAvailable(): Promise<boolean> {
  if (native === null) return Promise.resolve(false);
  const resolved = availability ?? native.isAvailable(deviceLocale()).catch(() => false);
  availability = resolved;
  return resolved;
}

/** Transcribes a finished recording on-device, biased toward the given terms. */
export async function transcribeWithLocalDictation(
  uri: string,
  contextualStrings: readonly string[],
): Promise<string> {
  if (native === null) {
    throw new Error("On-device dictation is not available in this build.");
  }
  return native.transcribe(uri, deviceLocale(), contextualStrings);
}
