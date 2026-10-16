import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("expo-audio", () => ({ createAudioPlayer: vi.fn() }));
import { createVoiceStartupAudio } from "./voiceStartupAudio";

function setup() {
  const events: string[] = [];
  const audio = createVoiceStartupAudio((choice) => {
    events.push(`${choice}:create`);
    return {
      loop: false,
      volume: 1,
      play: () => {
        events.push(`${choice}:play`);
      },
      pause: () => {
        events.push(`${choice}:pause`);
      },
      remove: () => {
        events.push(`${choice}:remove`);
      },
      release: () => {
        events.push(`${choice}:release`);
      },
    };
  });
  return { audio, events };
}
describe("voice startup audio", () => {
  it("stops and releases before switching, and repeated selections are inert", () => {
    const { audio, events } = setup();
    audio.start("ringing");
    audio.start("ringing");
    audio.start("jazz");
    audio.start("silence");
    audio.stop();
    expect(events).toEqual([
      "ringing:create",
      "ringing:play",
      "ringing:pause",
      "ringing:remove",
      "ringing:release",
      "jazz:create",
      "jazz:play",
      "jazz:pause",
      "jazz:remove",
      "jazz:release",
    ]);
  });
  it("stops synchronously on cancellation and prevents late starts after disposal", () => {
    const { audio, events } = setup();
    audio.start("jazz");
    audio.dispose();
    audio.start("ringing");
    audio.stop();
    audio.dispose();
    expect(events).toEqual([
      "jazz:create",
      "jazz:play",
      "jazz:pause",
      "jazz:remove",
      "jazz:release",
    ]);
  });
  it("still releases after a failed play or pause", () => {
    const release = vi.fn();
    const remove = vi.fn();
    const audio = createVoiceStartupAudio(() => ({
      loop: false,
      volume: 1,
      play: () => {
        throw new Error("play");
      },
      pause: () => {
        throw new Error("pause");
      },
      remove,
      release,
    }));
    expect(() => audio.start("ringing")).not.toThrow();
    expect(remove).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    audio.stop();
    expect(release).toHaveBeenCalledOnce();
  });
});
