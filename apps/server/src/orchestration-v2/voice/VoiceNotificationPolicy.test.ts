import { assert, it } from "@effect/vitest";
import {
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type VoiceNotice,
  type VoiceNoticeKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  composeNoticeBatch,
  isUrgentBatch,
  noticeForEvent,
  type VoiceThreadInfo,
} from "./VoiceNotificationPolicy.ts";

const threadId = ThreadId.make("thread-1");
const thread: VoiceThreadInfo = { threadId, title: "Fix login", ignored: false };

// Only the fields the policy reads; the rest of the payload is irrelevant here.
const runEvent = (status: OrchestrationV2Run["status"], runId = "run-1") =>
  ({
    type: "run.updated",
    threadId,
    payload: { id: RunId.make(runId), threadId, status },
  }) as OrchestrationV2DomainEvent;

const requestEvent = (
  status: OrchestrationV2RuntimeRequest["status"],
  kind: OrchestrationV2RuntimeRequest["kind"] = "command",
) =>
  ({
    type: "runtime-request.updated",
    threadId,
    payload: { id: RuntimeRequestId.make("req-1"), status, kind },
  }) as OrchestrationV2DomainEvent;

it("announces finished and failed runs and opens the agenda", () => {
  const completed = noticeForEvent(runEvent("completed"), thread);
  assert.deepStrictEqual(completed, {
    kind: "completed",
    threadId,
    threadTitle: "Fix login",
    text: "Fix login finished.",
    dedupeKey: "thread-1:run:run-1:completed",
    agenda: "open",
  });
  assert.strictEqual(noticeForEvent(runEvent("failed"), thread)?.kind, "failed");
  assert.notStrictEqual(
    noticeForEvent(runEvent("completed", "run-2"), thread)?.dedupeKey,
    completed?.dedupeKey,
  );
});

it("stays quiet for interrupted, waiting and in-progress runs", () => {
  for (const status of ["interrupted", "waiting", "running", "cancelled"] as const) {
    assert.isUndefined(noticeForEvent(runEvent(status), thread), status);
  }
});

it("announces pending runtime requests only", () => {
  const approval = noticeForEvent(requestEvent("pending"), thread);
  assert.strictEqual(approval?.kind, "approval");
  assert.strictEqual(approval?.text, "Fix login needs an approval.");
  assert.strictEqual(approval?.dedupeKey, "thread-1:request:req-1:approval");
  assert.strictEqual(
    noticeForEvent(requestEvent("pending", "user_input"), thread)?.text,
    "Fix login is waiting on you.",
  );
  assert.isUndefined(noticeForEvent(requestEvent("resolved"), thread));
  assert.isUndefined(noticeForEvent(requestEvent("expired"), thread));
});

it("ignores threads the caller marks ignored", () => {
  assert.isUndefined(noticeForEvent(runEvent("completed"), { ...thread, ignored: true }));
});

const notice = (kind: VoiceNoticeKind, title: string, second: number, id = `${title}-${kind}`) =>
  ({
    id,
    kind,
    threadId: ThreadId.make(title),
    threadTitle: title,
    text: `${title} ${kind}.`,
    createdAt: DateTime.makeUnsafe(Date.UTC(2026, 8, 30, 10, 0, second)),
  }) satisfies VoiceNotice;

it("orders a batch by priority then time and dedupes thread and kind", () => {
  const message = composeNoticeBatch([
    notice("completed", "A", 0),
    notice("approval", "B", 5),
    notice("failed", "C", 2),
    notice("failed", "D", 1),
    notice("completed", "A", 3, "A-completed-again"),
  ]);
  assert.strictEqual(message, "Update from T3: B approval. D failed. C failed. A completed.");
  assert.isTrue(isUrgentBatch([notice("completed", "A", 0), notice("failed", "C", 2)]));
  assert.isFalse(isUrgentBatch([notice("completed", "A", 0)]));
});

it("caps long batches", () => {
  const message = composeNoticeBatch(
    Array.from({ length: 8 }, (_, index) => notice("completed", `T${index}`, index)),
  );
  assert.isTrue(message.endsWith("T5 completed. And 2 more."));
  assert.strictEqual(composeNoticeBatch([]), "");
});
