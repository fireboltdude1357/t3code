import { assert, it } from "@effect/vitest";
import { ThreadId, type VoiceAgendaItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { buildBriefing, estimateTokens } from "./VoiceBriefing.ts";
import type { VoiceTranscriptEntry } from "./VoiceStore.ts";

const at = DateTime.makeUnsafe("2026-09-30T10:00:00.000Z");
const entry = (role: "user" | "assistant", text: string): VoiceTranscriptEntry => ({
  generation: 1,
  role,
  text,
  at,
});

const agendaItem: VoiceAgendaItem = {
  id: "voice-agenda:1",
  kind: "thread",
  threadId: ThreadId.make("thread-1"),
  title: "Fix login",
  detail: "Fix login failed.",
  status: "open",
  openedAt: at,
  closedAt: null,
};

const empty = { agenda: [], threads: [], transcript: [], undelivered: [], generation: 1 };

it("briefs agenda, focus thread, notices and newest threads first", () => {
  const threads = Array.from({ length: 30 }, (_, index) => ({
    threadId: ThreadId.make(`t${index}`),
    title: `Thread ${index}`,
    projectTitle: "t3code",
    status: "idle",
    updatedAt: DateTime.add(at, { minutes: index }),
  }));
  const { initialItems } = buildBriefing({
    ...empty,
    agenda: [agendaItem, { ...agendaItem, id: "closed", title: "Old", status: "closed" }],
    threads,
    undelivered: [
      {
        id: "n1",
        kind: "completed",
        threadId: ThreadId.make("t1"),
        threadTitle: "Thread 1",
        text: "Thread 1 finished.",
        createdAt: at,
      },
    ],
    focusThread: { threadId: ThreadId.make("t5"), title: "Thread 5" },
  });
  assert.strictEqual(initialItems.length, 1);
  const briefing = initialItems[0]!;
  assert.strictEqual(briefing.role, "developer");
  assert.include(briefing.text, "Fix login [thread thread-1, voice-agenda:1]");
  assert.notInclude(briefing.text, "Old");
  assert.include(briefing.text, "Thread 1 finished.");
  assert.include(briefing.text, `"Thread 5" (t5)`);
  assert.notInclude(briefing.text, "ongoing conversation");
  // Only the 25 most recent threads, newest first.
  assert.include(briefing.text, "- Thread 29 ");
  assert.notInclude(briefing.text, "- Thread 4 ");
  assert.isBelow(briefing.text.indexOf("Thread 29"), briefing.text.indexOf("Thread 28"));
});

it("replays the transcript in order and marks later generations as a continuation", () => {
  const { initialItems } = buildBriefing({
    ...empty,
    generation: 2,
    transcript: [
      entry("user", "What's running?"),
      entry("assistant", "Two threads."),
      entry("assistant", "Both are idle."),
      entry("user", "Thanks."),
    ],
  });
  assert.include(initialItems[0]!.text, "ongoing conversation");
  assert.deepStrictEqual(initialItems.slice(1), [
    { role: "user", text: "What's running?" },
    { role: "assistant", text: "Two threads. Both are idle." },
    { role: "user", text: "Thanks." },
  ]);
});

it("drops the oldest transcript to stay within the item and token limits", () => {
  const long = Array.from({ length: 400 }, (_, index) =>
    entry(index % 2 === 0 ? "user" : "assistant", `turn ${index} ${"x".repeat(200)}`),
  );
  const { initialItems } = buildBriefing({ ...empty, transcript: long });
  const tokens = initialItems.reduce((sum, item) => sum + estimateTokens(item.text), 0);
  assert.isAtMost(tokens, 7_000);
  assert.isAtMost(initialItems.length, 128);
  assert.include(initialItems.at(-1)!.text, "turn 399 ");
  assert.notInclude(initialItems[1]!.text, "turn 0 ");

  const many = Array.from({ length: 300 }, (_, index) =>
    entry(index % 2 === 0 ? "user" : "assistant", `t${index}`),
  );
  assert.strictEqual(buildBriefing({ ...empty, transcript: many }).initialItems.length, 128);
});
