import { describe, expect, it } from "@effect/vitest";

import type { LunaDictionaryEntry, LunaMessage } from "./lunaHostApi";
import {
  dictionaryEntryLabel,
  latestCompleteAssistantMessage,
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
