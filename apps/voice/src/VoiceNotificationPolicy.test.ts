import { assert, it } from "@effect/vitest";
import {
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2RuntimeRequest,
  type VoiceNotice,
  type VoiceNoticeKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  composeNoticeBatch,
  isUrgentBatch,
  noticeForRequest,
  noticeForRun,
  type VoiceThreadInfo,
} from "./VoiceNotificationPolicy.ts";

const threadId = ThreadId.make("thread-1");
const thread: VoiceThreadInfo = { threadId, title: "Fix login", ignored: false };
const run1 = RunId.make("run-1");

// Only the fields the policy reads; the rest of the request is irrelevant here.
const request = (
  status: OrchestrationV2RuntimeRequest["status"],
  kind: OrchestrationV2RuntimeRequest["kind"] = "command",
) => ({ id: RuntimeRequestId.make("req-1"), status, kind }) as OrchestrationV2RuntimeRequest;

it("announces finished and failed runs and opens the agenda", () => {
  const completed = noticeForRun(run1, "completed", thread);
  assert.deepStrictEqual(completed, {
    kind: "completed",
    threadId,
    threadTitle: "Fix login",
    text: "Fix login finished.",
    dedupeKey: "thread-1:run:run-1:completed",
    agenda: "open",
  });
  assert.strictEqual(noticeForRun(run1, "failed", thread)?.kind, "failed");
  assert.notStrictEqual(
    noticeForRun(RunId.make("run-2"), "completed", thread)?.dedupeKey,
    completed?.dedupeKey,
  );
});

it("stays quiet for interrupted, waiting and in-progress runs", () => {
  for (const status of ["interrupted", "waiting", "running", "cancelled", "idle"] as const) {
    assert.isUndefined(noticeForRun(run1, status, thread), status);
  }
});

it("announces pending runtime requests only", () => {
  const approval = noticeForRequest(request("pending"), thread);
  assert.strictEqual(approval?.kind, "approval");
  assert.strictEqual(approval?.text, "Fix login needs an approval.");
  assert.strictEqual(approval?.dedupeKey, "thread-1:request:req-1:approval");
  assert.strictEqual(
    noticeForRequest(request("pending", "user_input"), thread)?.text,
    "Fix login is waiting on you.",
  );
  assert.isUndefined(noticeForRequest(request("resolved"), thread));
  assert.isUndefined(noticeForRequest(request("expired"), thread));
});

it("ignores threads the caller marks ignored", () => {
  assert.isUndefined(noticeForRun(run1, "completed", { ...thread, ignored: true }));
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
