import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("../../lib/uuid", () => ({ uuidv4: () => "test-id" }));

import { voiceSpeechFileExtension } from "./voiceSidecarSpeech";

describe("voiceSpeechFileExtension", () => {
  it.each([
    ["audio/mpeg", "mp3"],
    ["audio/wav; codecs=pcm", "wav"],
    ["audio/mp4", "m4a"],
    ["audio/ogg", "ogg"],
    ["audio/webm", "webm"],
    ["audio/flac", "flac"],
  ])("maps %s to .%s", (mimeType, extension) => {
    expect(voiceSpeechFileExtension(mimeType)).toBe(extension);
  });

  it("uses a safe generic extension for an unknown audio type", () => {
    expect(voiceSpeechFileExtension("audio/vnd.example")).toBe("audio");
  });
});
