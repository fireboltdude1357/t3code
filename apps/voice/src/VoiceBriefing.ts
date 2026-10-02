import type { ThreadId, VoiceAgendaItem, VoiceNotice } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { VoiceTranscriptEntry } from "./VoiceStore.ts";

export interface VoiceBriefingThread {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly projectTitle: string;
  readonly status: string;
  readonly updatedAt: DateTime.Utc;
}

export interface VoiceBriefingInput {
  readonly agenda: ReadonlyArray<VoiceAgendaItem>;
  readonly threads: ReadonlyArray<VoiceBriefingThread>;
  readonly transcript: ReadonlyArray<VoiceTranscriptEntry>;
  readonly undelivered: ReadonlyArray<VoiceNotice>;
  readonly focusThread?: { readonly threadId: ThreadId; readonly title: string };
  readonly generation: number;
}

export interface VoiceBriefingItem {
  readonly role: "user" | "assistant" | "developer";
  readonly text: string;
}

// Codex realtime accepts at most 128 initial items and about 8,192 estimated
// tokens; stay well under the token limit.
const MAX_ITEMS = 128;
const TOKEN_BUDGET = 7_000;
const MAX_THREADS = 25;
const MAX_NOTICES = 20;
const MAX_AGENDA = 30;

/** Codex's rough estimate: one token per four characters. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const minute = (at: DateTime.Utc) => DateTime.formatIso(at).slice(0, 16).replace("T", " ") + "Z";

function briefingText(input: VoiceBriefingInput): string {
  const sections: string[] = [
    "[T3 BRIEFING] Your working state from T3 Code. This is context, not user speech.",
  ];
  if (input.generation > 1) {
    sections.push(
      "This continues an ongoing conversation with the user. Do not greet them again or restart; pick up where the transcript below leaves off.",
    );
  }
  if (input.focusThread) {
    sections.push(
      `The user opened the call from "${input.focusThread.title}" (${input.focusThread.threadId}). Start with that thread.`,
    );
  }

  const agenda = input.agenda.filter((item) => item.status === "open").slice(0, MAX_AGENDA);
  sections.push(
    agenda.length === 0
      ? "Open agenda: nothing."
      : [
          "Open agenda (come back to these):",
          ...agenda.map((item) => {
            const where = item.threadId === null ? "topic" : `thread ${item.threadId}`;
            const detail = item.detail === "" ? "" : `: ${item.detail}`;
            return `- ${item.title} [${where}, ${item.id}]${detail}`;
          }),
        ].join("\n"),
  );

  const notices = input.undelivered.slice(0, MAX_NOTICES);
  if (notices.length > 0) {
    sections.push(
      ["Not yet told to the user:", ...notices.map((notice) => `- ${notice.text}`)].join("\n"),
    );
  }

  const threads = input.threads
    .toSorted((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt))
    .slice(0, MAX_THREADS);
  if (threads.length > 0) {
    sections.push(
      [
        "Recent threads (newest first):",
        ...threads.map(
          (thread) =>
            `- ${thread.title} (${thread.projectTitle}, ${thread.threadId}): ${thread.status}, updated ${minute(thread.updatedAt)}`,
        ),
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

/** Joins consecutive entries from the same speaker, since one turn often arrives in parts. */
function transcriptItems(
  transcript: ReadonlyArray<VoiceTranscriptEntry>,
): Array<{ role: "user" | "assistant"; text: string }> {
  const items: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const entry of transcript) {
    const text = entry.text.trim();
    if (text === "") continue;
    const last = items.at(-1);
    if (last?.role === entry.role) last.text = `${last.text} ${text}`;
    else items.push({ role: entry.role, text });
  }
  return items;
}

/**
 * Builds the `initialItems` for a new session generation: one developer
 * briefing, then as much recent transcript as fits the item and token limits.
 * The oldest transcript is dropped first.
 */
export function buildBriefing(input: VoiceBriefingInput): {
  readonly initialItems: ReadonlyArray<VoiceBriefingItem>;
} {
  const briefing = briefingText(input).slice(0, TOKEN_BUDGET * 4);
  let budget = TOKEN_BUDGET - estimateTokens(briefing);

  const kept: VoiceBriefingItem[] = [];
  for (const item of transcriptItems(input.transcript).toReversed()) {
    const cost = estimateTokens(item.text);
    if (kept.length + 1 >= MAX_ITEMS || cost > budget) break;
    budget -= cost;
    kept.push(item);
  }

  return { initialItems: [{ role: "developer", text: briefing }, ...kept.toReversed()] };
}
