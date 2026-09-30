import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { layer as voiceStoreLayer, VoiceStore } from "./VoiceStore.ts";

const TestLayer = voiceStoreLayer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeCrypto.layer),
);

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

const notice = (id: string, dedupeKey: string, createdAt: string) => ({
  id,
  dedupeKey,
  kind: "completed" as const,
  threadId: threadA,
  threadTitle: "Thread A",
  text: "Thread A finished.",
  createdAt: DateTime.makeUnsafe(createdAt),
});

it.effect("persists an increasing generation number", () =>
  Effect.gen(function* () {
    const store = yield* VoiceStore;
    assert.strictEqual(yield* store.nextGeneration, 1);
    assert.strictEqual(yield* store.nextGeneration, 2);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps one open agenda item per thread and reopens after close", () =>
  Effect.gen(function* () {
    const store = yield* VoiceStore;
    const first = yield* store.openThreadItem({ threadId: threadA, title: "A", detail: "failed" });
    const refreshed = yield* store.openThreadItem({
      threadId: threadA,
      title: "A2",
      detail: "completed",
    });
    assert.strictEqual(refreshed.id, first.id);
    assert.strictEqual(refreshed.detail, "completed");
    assert.strictEqual(refreshed.kind, "thread");
    yield* TestClock.adjust("1 second");
    yield* store.openThreadItem({ threadId: threadB, title: "B", detail: "input" });

    yield* TestClock.adjust("1 second");
    yield* store.closeThreadItem(threadA);
    const reopened = yield* store.openThreadItem({ threadId: threadA, title: "A", detail: "x" });
    assert.notStrictEqual(reopened.id, first.id);

    const open = yield* store.listAgenda({ status: "open" });
    assert.deepStrictEqual(
      open.map((item) => item.threadId),
      [threadB, threadA],
    );
    const closed = yield* store.listAgenda({ status: "closed" });
    assert.strictEqual(closed.length, 1);
    assert.isNotNull(closed[0]?.closedAt);
    assert.strictEqual((yield* store.listAgenda()).length, 3);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("opens and closes topics by id", () =>
  Effect.gen(function* () {
    const store = yield* VoiceStore;
    const topic = yield* store.openTopic({ title: "Remind me", detail: "about X" });
    assert.strictEqual(topic.kind, "topic");
    assert.isNull(topic.threadId);
    assert.isTrue(yield* store.closeItem(topic.id));
    assert.isFalse(yield* store.closeItem(topic.id));
    assert.isFalse(yield* store.closeItem("missing"));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("dedupes notices and tracks delivery", () =>
  Effect.gen(function* () {
    const store = yield* VoiceStore;
    assert.isTrue(yield* store.recordNotice(notice("n1", "k1", "2026-09-30T10:00:00.000Z")));
    assert.isFalse(yield* store.recordNotice(notice("n1b", "k1", "2026-09-30T10:00:01.000Z")));
    assert.isTrue(yield* store.recordNotice(notice("n2", "k2", "2026-09-30T10:00:02.000Z")));

    const undelivered = yield* store.undeliveredNotices(10);
    assert.deepStrictEqual(
      undelivered.map((n) => n.id),
      ["n1", "n2"],
    );
    assert.strictEqual(DateTime.formatIso(undelivered[0]!.createdAt), "2026-09-30T10:00:00.000Z");

    yield* store.markDelivered(["n1"]);
    yield* store.markDelivered([]);
    assert.deepStrictEqual(
      (yield* store.undeliveredNotices(10)).map((n) => n.id),
      ["n2"],
    );
    assert.deepStrictEqual(
      (yield* store.recentNotices(10)).map((n) => n.id),
      ["n2", "n1"],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("returns the last transcript entries oldest first", () =>
  Effect.gen(function* () {
    const store = yield* VoiceStore;
    for (const [index, text] of ["one", "two", "three"].entries()) {
      yield* store.appendTranscript({
        generation: index < 2 ? 1 : 2,
        role: index % 2 === 0 ? "user" : "assistant",
        text,
        at: DateTime.makeUnsafe(Date.UTC(2026, 8, 30, 10, 0, index)),
      });
    }
    const recent = yield* store.recentTranscript(2);
    assert.deepStrictEqual(
      recent.map((entry) => [entry.generation, entry.role, entry.text]),
      [
        [1, "assistant", "two"],
        [2, "user", "three"],
      ],
    );
    assert.strictEqual(recent[1] && DateTime.formatIso(recent[1].at), "2026-09-30T10:00:02.000Z");
  }).pipe(Effect.provide(TestLayer)),
);
