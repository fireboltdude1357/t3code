import { describe, expect, it } from "@effect/vitest";

import type { LunaDictionaryEntry, LunaMessage } from "./lunaHostApi";
import {
  dictionaryEntryLabel,
  handsfreeStatus,
  handsfreeTapAction,
  latestCompleteAssistantMessage,
  resolveHandsfreePhase,
  sentenceCountLabel,
  serviceStatusLabel,
} from "./voiceSidecarPresentation";

const message = (id: string, role: "user" | "assistant"): LunaMessage => ({
  id,
  role,
  status: "complete",
  text: id,
  hasRecording: false,
  hasSpeech: false,
  createdAt: "2026-08-31T12:00:00.000Z",
});

const entry = (input: Partial<LunaDictionaryEntry>): LunaDictionaryEntry => ({
  id: "entry",
  source: "learned",
  kind: "term",
  phrase: "phrase",
  replacement: null,
  createdAt: "2026-08-31T12:00:00.000Z",
  ...input,
});

describe("voice sidecar presentation", () => {
  it("uses the newest assistant message for road mode", () => {
    expect(
      latestCompleteAssistantMessage([
        message("first", "assistant"),
        message("question", "user"),
        message("latest", "assistant"),
      ])?.id,
    ).toBe("latest");
    expect(latestCompleteAssistantMessage([message("question", "user")])).toBeNull();
  });

  it("labels dictionary entries by kind", () => {
    expect(dictionaryEntryLabel(entry({ kind: "term", phrase: "Uniwind" }))).toBe("Uniwind");
    expect(
      dictionaryEntryLabel(entry({ kind: "correction", phrase: "easy", replacement: "EAS" })),
    ).toBe("easy → EAS");
  });

  it("labels service statuses and sentence counts", () => {
    expect(serviceStatusLabel("ready")).toBe("Ready");
    expect(serviceStatusLabel("not-configured")).toBe("Not configured");
    expect(sentenceCountLabel(1)).toBe("1 sentence");
    expect(sentenceCountLabel(3)).toBe("3 sentences");
  });
});

describe("handsfree phase", () => {
  const base = {
    transcriptionReady: true,
    recorderPhase: "idle",
    asking: false,
    sessionStatus: "ready",
    speechStatus: "ready",
    playing: false,
    pausedMidway: false,
  } as const satisfies Parameters<typeof resolveHandsfreePhase>[0];

  it("prefers what the device is doing over what the host is doing", () => {
    expect(resolveHandsfreePhase({ ...base, transcriptionReady: false, playing: true })).toBe(
      "unavailable",
    );
    expect(
      resolveHandsfreePhase({
        ...base,
        recorderPhase: "recording",
        sessionStatus: "waiting-for-luna",
      }),
    ).toBe("listening");
    expect(resolveHandsfreePhase({ ...base, asking: true })).toBe("transcribing");
    expect(resolveHandsfreePhase({ ...base, sessionStatus: "waiting-for-luna" })).toBe("thinking");
    expect(resolveHandsfreePhase({ ...base, speechStatus: "loading" })).toBe("preparing-voice");
    expect(resolveHandsfreePhase({ ...base, playing: true })).toBe("speaking");
    expect(resolveHandsfreePhase({ ...base, pausedMidway: true })).toBe("paused");
    expect(resolveHandsfreePhase(base)).toBe("idle");
  });

  it("maps one tap to record, send, pause, or nothing", () => {
    expect(handsfreeTapAction("idle")).toBe("record");
    expect(handsfreeTapAction("paused")).toBe("record");
    expect(handsfreeTapAction("listening")).toBe("send");
    expect(handsfreeTapAction("speaking")).toBe("pause");
    expect(handsfreeTapAction("thinking")).toBe("none");
    expect(handsfreeTapAction("unavailable")).toBe("none");
  });

  it("shows the recording clock while listening", () => {
    expect(handsfreeStatus("listening", 65).hint).toBe("1:05 · Tap to send.");
    expect(handsfreeStatus("thinking", 0).hint).toBeNull();
  });
});
