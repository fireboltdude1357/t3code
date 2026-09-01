import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: async () => ({ granted: true }),
  setAudioModeAsync: async () => undefined,
  setIsAudioActiveAsync: async () => undefined,
  useAudioRecorder: () => ({}),
}));

vi.mock("expo-file-system", () => ({
  File: class {},
}));

vi.mock("@react-navigation/native", () => ({
  useFocusEffect: () => undefined,
}));

vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));

import { ignoreReleasedNativeObject } from "./releasedNativeObject";
import { discardInterruptedVoiceSidecarRecording } from "./useVoiceSidecarRecorder";

const quietStatus = {
  error: null,
  hasError: false,
  isFinished: false,
  mediaServicesDidReset: false,
  url: null,
};

describe("discardInterruptedVoiceSidecarRecording", () => {
  it("ignores ordinary recorder updates", async () => {
    const stop = vi.fn(async () => undefined);
    const remove = vi.fn();
    const release = vi.fn(async () => undefined);

    const message = await discardInterruptedVoiceSidecarRecording({
      status: quietStatus,
      recordingUris: ["file:///partial.m4a"],
      stop,
      remove,
      release,
    });

    expect(message).toBeNull();
    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("discards recorder errors and releases the audio session", async () => {
    const stop = vi.fn(async () => undefined);
    const remove = vi.fn();
    const release = vi.fn(async () => undefined);

    const message = await discardInterruptedVoiceSidecarRecording({
      status: {
        ...quietStatus,
        error: "Audio route changed",
        hasError: true,
        url: "file:///completed.m4a",
      },
      recordingUris: ["file:///partial.m4a", "file:///completed.m4a"],
      stop,
      remove,
      release,
    });

    expect(message).toBe("Audio route changed");
    expect(stop).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith("file:///completed.m4a");
    expect(remove).toHaveBeenCalledWith("file:///partial.m4a");
    expect(release).toHaveBeenCalledOnce();
  });

  it("handles media resets and unexpected completion", async () => {
    const resetRelease = vi.fn(async () => undefined);
    const resetMessage = await discardInterruptedVoiceSidecarRecording({
      status: { ...quietStatus, mediaServicesDidReset: true },
      recordingUris: [],
      stop: vi.fn(async () => {
        throw new Error("recorder is invalid");
      }),
      remove: vi.fn(),
      release: resetRelease,
    });

    const finishedStop = vi.fn(async () => undefined);
    const finishedRemove = vi.fn();
    const finishedMessage = await discardInterruptedVoiceSidecarRecording({
      status: { ...quietStatus, isFinished: true, url: "file:///early.m4a" },
      recordingUris: [],
      stop: finishedStop,
      remove: finishedRemove,
      release: vi.fn(async () => undefined),
    });

    expect(resetMessage).toBe("Voice recording was interrupted.");
    expect(resetRelease).toHaveBeenCalledOnce();
    expect(finishedMessage).toBe("Voice recording ended unexpectedly.");
    expect(finishedStop).not.toHaveBeenCalled();
    expect(finishedRemove).toHaveBeenCalledWith("file:///early.m4a");
  });
});

describe("ignoreReleasedNativeObject", () => {
  it("returns the value from a live native call", () => {
    expect(ignoreReleasedNativeObject(() => "file:///recording.m4a")).toBe("file:///recording.m4a");
  });

  it("swallows the released shared object throw so cleanup continues", () => {
    expect(
      ignoreReleasedNativeObject(() => {
        throw new Error(
          "Unable to find the native shared object associated with given JavaScript object",
        );
      }),
    ).toBeUndefined();
  });
});
