import { describe, expect, it } from "@effect/vitest";

import { applyDictionaryCorrections, selectDictationTerms } from "./dictationVocabulary";
import type { LunaDictionaryEntry } from "./lunaHostApi";

function entry(input: {
  readonly kind: "term" | "correction";
  readonly phrase: string;
  readonly replacement?: string;
}): LunaDictionaryEntry {
  return {
    id: `${input.kind}-${input.phrase}`,
    source: "wispr",
    kind: input.kind,
    phrase: input.phrase,
    replacement: input.replacement ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("selectDictationTerms", () => {
  it("prefers canonical spellings, dedupes, and keeps host order", () => {
    const terms = selectDictationTerms([
      entry({ kind: "term", phrase: "DevSTAC" }),
      entry({ kind: "correction", phrase: "adaline", replacement: "Atalan" }),
      entry({ kind: "term", phrase: "atalan" }),
      entry({ kind: "term", phrase: "  " }),
    ]);
    expect(terms).toEqual(["DevSTAC", "Atalan"]);
  });

  it("caps the list at Apple's 100-phrase limit", () => {
    const entries = Array.from({ length: 130 }, (_, index) =>
      entry({ kind: "term", phrase: `term-${index}` }),
    );
    expect(selectDictationTerms(entries)).toHaveLength(100);
  });
});

describe("applyDictionaryCorrections", () => {
  it("replaces whole words case-insensitively, longest phrase first", () => {
    const entries = [
      entry({ kind: "correction", phrase: "dev", replacement: "developer" }),
      entry({ kind: "correction", phrase: "dev stack", replacement: "DevSTAC" }),
      entry({ kind: "term", phrase: "ignored" }),
    ];
    expect(applyDictionaryCorrections("the Dev Stack demo at devstack", entries)).toBe(
      "the DevSTAC demo at devstack",
    );
  });

  it("handles adjacent occurrences and regex characters", () => {
    const entries = [entry({ kind: "correction", phrase: "t3 (code)", replacement: "T3 Code" })];
    expect(applyDictionaryCorrections("t3 (code) t3 (code)", entries)).toBe("T3 Code T3 Code");
  });
});
