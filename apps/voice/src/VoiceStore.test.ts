import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { RuntimeRequestId, ThreadId, type VoiceNotice } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory as SqlitePersistenceMemory, migrate } from "./Database.ts";
import { layer as voiceStoreLayer, VoiceStore } from "./VoiceStore.ts";

const StoreLayer = voiceStoreLayer.pipe(Layer.provide(NodeCrypto.layer));
const TestLayer = StoreLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

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

const requestNotice = (input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly requestId?: RuntimeRequestId;
  readonly kind: "input" | "approval";
  readonly createdAt: string;
}) =>
  ({
    ...input,
    dedupeKey: `${input.threadId}:request:${input.requestId ?? "unknown"}:${input.kind}`,
    threadTitle: "Request thread",
    text: "Request thread needs attention.",
    createdAt: DateTime.makeUnsafe(input.createdAt),
  }) satisfies VoiceNotice & { readonly dedupeKey: string };

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

it.effect("resolves only the exact request and preserves history, dedupe, and later requests", () =>
  Effect.gen(function* () {
    const store = yield* VoiceStore;
    const sql = yield* SqlClient.SqlClient;
    const requestId = RuntimeRequestId.make("request:old:input");
    const laterRequestId = RuntimeRequestId.make("request:old:input:later");
    const first = requestNotice({
      id: "old-input",
      threadId: threadA,
      requestId,
      kind: "input",
      createdAt: "2026-09-30T10:00:00.000Z",
    });
    yield* store.recordNotice(first);
    yield* store.recordNotice({
      ...first,
      id: "old-approval",
      kind: "approval",
      dedupeKey: "approval",
    });
    yield* store.recordNotice(
      requestNotice({
        id: "other-thread",
        threadId: threadB,
        requestId,
        kind: "input",
        createdAt: "2026-09-30T10:00:01.000Z",
      }),
    );
    yield* store.markDelivered(["old-input", "other-thread"]);
    yield* store.recordNotice({
      ...notice("completed", "completed", "2026-09-30T10:00:03.000Z"),
      requestId,
    });
    yield* store.recordNotice({
      ...notice("failed", "failed", "2026-09-30T10:00:04.000Z"),
      kind: "failed",
    });

    yield* store.resolveRequestNotice(threadA, requestId);
    yield* store.recordNotice(
      requestNotice({
        id: "later-request",
        threadId: threadA,
        requestId: laterRequestId,
        kind: "approval",
        createdAt: "2026-09-30T10:00:02.000Z",
      }),
    );
    yield* store.resolveRequestNotice(threadA, requestId);
    assert.isFalse(yield* store.recordNotice({ ...first, id: "duplicate-resolved" }));
    assert.deepStrictEqual(
      (yield* store.pendingRequestNotices(10)).map((n) => [n.id, n.requestId]),
      [
        ["later-request", laterRequestId],
        ["other-thread", requestId],
      ],
    );
    assert.deepStrictEqual(
      (yield* store.pendingRequestNotices(1)).map((n) => n.id),
      ["later-request"],
    );
    assert.deepStrictEqual(
      (yield* store.undeliveredNotices(10)).map((n) => n.id),
      ["later-request", "completed", "failed"],
    );
    assert.deepStrictEqual(
      (yield* store.recentNotices(10)).map((n) => n.id),
      ["failed", "completed", "later-request", "other-thread"],
    );
    const history = yield* sql<{ readonly id: string; readonly resolvedAt: string | null }>`
      SELECT notice_id AS id, resolved_at AS resolvedAt FROM voice_notice_ledger ORDER BY notice_id
    `;
    assert.strictEqual(history.length, 6);
    assert.deepStrictEqual(
      history.filter((row) => row.resolvedAt !== null).map((row) => row.id),
      ["old-approval", "old-input"],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "refreshes matching attention details without closing conversations or replacing newer details",
  () =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      const requestId = RuntimeRequestId.make("request:agenda");
      const threadCompleted = ThreadId.make("thread-completed");
      const threadFailed = ThreadId.make("thread-failed");
      const threadNewer = ThreadId.make("thread-newer");
      const questionText = "Thread A is waiting on you.";
      const approvalText = "Thread B needs approval.";
      const details = [
        { threadId: threadA, kind: "input" as const, text: questionText, detail: questionText },
        { threadId: threadB, kind: "approval" as const, text: approvalText, detail: approvalText },
        {
          threadId: threadCompleted,
          kind: "input" as const,
          text: questionText,
          detail: "Thread finished.",
        },
        {
          threadId: threadFailed,
          kind: "approval" as const,
          text: approvalText,
          detail: "Thread failed.",
        },
        {
          threadId: threadNewer,
          kind: "input" as const,
          text: questionText,
          detail: "A newer question needs an answer.",
        },
      ];
      for (const [index, input] of details.entries()) {
        yield* store.recordNotice({
          ...requestNotice({
            id: `agenda-${index}`,
            threadId: input.threadId,
            requestId,
            kind: input.kind,
            createdAt: `2026-09-30T10:00:0${index}.000Z`,
          }),
          text: input.text,
        });
        yield* store.openThreadItem({
          threadId: input.threadId,
          title: "Conversation",
          detail: input.detail,
        });
      }
      const topic = yield* store.openTopic({ title: "Topic", detail: questionText });
      yield* store.markDelivered(["agenda-0", "agenda-1"]);

      yield* store.resolveRequestNotice(threadA, requestId);
      const afterResolution = yield* store.listAgenda({ status: "open" });
      assert.strictEqual(afterResolution.length, 6);
      assert.strictEqual(
        afterResolution.find((item) => item.threadId === threadA)?.detail,
        "The question was answered or closed.",
      );
      assert.strictEqual(
        afterResolution.find((item) => item.threadId === threadB)?.detail,
        approvalText,
      );

      yield* store.openThreadItem({
        threadId: threadA,
        title: "Conversation",
        detail: questionText,
      });
      yield* store.resolveRequestNotice(threadA, requestId);
      yield* store.reconcileRequestNotices([]);
      const afterReconciliation = yield* store.listAgenda({ status: "open" });
      assert.strictEqual(afterReconciliation.length, 6);
      assert.strictEqual(
        afterReconciliation.find((item) => item.threadId === threadA)?.detail,
        questionText,
      );
      assert.strictEqual(
        afterReconciliation.find((item) => item.threadId === threadB)?.detail,
        "The approval request was answered or closed.",
      );
      for (const input of details.slice(2)) {
        assert.strictEqual(
          afterReconciliation.find((item) => item.threadId === input.threadId)?.detail,
          input.detail,
        );
      }
      assert.strictEqual(
        afterReconciliation.find((item) => item.id === topic.id)?.detail,
        questionText,
      );
      assert.deepStrictEqual(yield* store.listAgenda({ status: "closed" }), []);
    }).pipe(Effect.provide(TestLayer)),
);

for (const resolution of ["direct", "reconcile"] as const) {
  it.effect(`preserves identical pending agenda text during ${resolution} resolution`, () =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      for (const kind of ["input", "approval"] as const) {
        const threadId = kind === "input" ? threadA : threadB;
        const text = kind === "input" ? "Thread is waiting on you." : "Thread needs approval.";
        const olderRequestId = RuntimeRequestId.make(`${kind}:older`);
        const pendingRequestId = RuntimeRequestId.make(`${kind}:pending`);
        const older = {
          ...requestNotice({
            id: `${kind}-older`,
            threadId,
            requestId: olderRequestId,
            kind,
            createdAt: "2026-09-30T10:00:00.000Z",
          }),
          text,
        };
        const pending = {
          ...requestNotice({
            id: `${kind}-pending`,
            threadId,
            requestId: pendingRequestId,
            kind,
            createdAt: "2026-09-30T10:00:01.000Z",
          }),
          text,
        };
        yield* store.recordNotice(older);
        yield* store.recordNotice(pending);
        yield* store.markDelivered(resolution === "direct" ? [older.id, pending.id] : [older.id]);
        const agenda = yield* store.openThreadItem({
          threadId,
          title: "Conversation",
          detail: text,
        });

        if (resolution === "direct") {
          yield* store.resolveRequestNotice(threadId, olderRequestId);
        } else {
          yield* store.reconcileRequestNotices([{ threadId, requestId: pendingRequestId }]);
        }
        const stillOpen = (yield* store.listAgenda({ status: "open" })).find(
          (item) => item.id === agenda.id,
        );
        assert.strictEqual(stillOpen?.detail, text);
        assert.deepStrictEqual(
          (yield* store.pendingRequestNotices(10)).map((notice) => notice.requestId),
          [pendingRequestId],
        );

        if (resolution === "direct") {
          yield* store.resolveRequestNotice(threadId, pendingRequestId);
        } else {
          yield* store.reconcileRequestNotices([]);
        }
        const resolved = (yield* store.listAgenda({ status: "open" })).find(
          (item) => item.id === agenda.id,
        );
        assert.strictEqual(
          resolved?.detail,
          kind === "input"
            ? "The question was answered or closed."
            : "The approval request was answered or closed.",
        );
        assert.deepStrictEqual(yield* store.pendingRequestNotices(10), []);
      }
    }).pipe(Effect.provide(TestLayer)),
  );
}

it.effect("persists request identity and resolution across store instances", () =>
  Effect.gen(function* () {
    const requestId = RuntimeRequestId.make("persisted:request");
    yield* Effect.gen(function* () {
      const store = yield* VoiceStore;
      yield* store.recordNotice(
        requestNotice({
          id: "persisted",
          threadId: threadA,
          requestId,
          kind: "input",
          createdAt: "2026-09-30T10:00:00.000Z",
        }),
      );
      yield* store.markDelivered(["persisted"]);
    }).pipe(Effect.provide(StoreLayer));

    yield* Effect.gen(function* () {
      const store = yield* VoiceStore;
      assert.strictEqual((yield* store.pendingRequestNotices(10))[0]?.requestId, requestId);
      yield* store.resolveRequestNotice(threadA, requestId);
    }).pipe(Effect.provide(StoreLayer));

    yield* Effect.gen(function* () {
      const store = yield* VoiceStore;
      assert.deepStrictEqual(yield* store.pendingRequestNotices(10), []);
      assert.deepStrictEqual(yield* store.recentNotices(10), []);
    }).pipe(Effect.provide(StoreLayer));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "reconciles missed resolutions and unknown legacy notices against exact request pairs",
  () =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      const requestId = RuntimeRequestId.make("request:current");
      const staleRequestId = RuntimeRequestId.make("request:stale");
      for (const [index, input] of [
        { id: "active", threadId: threadA, requestId },
        { id: "missed", threadId: threadA, requestId: staleRequestId },
        { id: "other-thread", threadId: threadB, requestId },
        { id: "legacy", threadId: threadB },
      ].entries()) {
        yield* store.recordNotice(
          requestNotice({
            ...input,
            kind: index % 2 === 0 ? "input" : "approval",
            createdAt: `2026-09-30T10:00:0${index}.000Z`,
          }),
        );
      }
      yield* store.recordNotice(notice("completed", "completed", "2026-09-30T10:00:04.000Z"));
      yield* store.markDelivered(["active", "missed"]);
      assert.isUndefined(
        (yield* store.pendingRequestNotices(10)).find((n) => n.id === "legacy")?.requestId,
      );

      yield* store.reconcileRequestNotices([{ threadId: threadA, requestId }]);
      assert.deepStrictEqual(
        (yield* store.pendingRequestNotices(10)).map((n) => n.id),
        ["active"],
      );
      assert.deepStrictEqual(
        (yield* store.undeliveredNotices(10)).map((n) => n.id),
        ["completed"],
      );
      assert.deepStrictEqual(
        (yield* store.recentNotices(10)).map((n) => n.id),
        ["completed", "active"],
      );
      yield* store.reconcileRequestNotices([]);
      assert.deepStrictEqual(yield* store.pendingRequestNotices(10), []);
      assert.deepStrictEqual(
        (yield* store.recentNotices(10)).map((n) => n.id),
        ["completed"],
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "restores omitted pending requests before settling absent requests and preserves delivery history",
  () =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      const sql = yield* SqlClient.SqlClient;
      for (const kind of ["input", "approval"] as const) {
        const threadId = kind === "input" ? threadA : threadB;
        const requestId = RuntimeRequestId.make(`${kind}:reappearing`);
        const pending = requestNotice({
          id: `${kind}-reappearing`,
          threadId,
          requestId,
          kind,
          createdAt: "2026-09-30T10:00:01.000Z",
        });
        yield* store.recordNotice(pending);
        yield* store.markDelivered([pending.id]);
        const agenda = yield* store.openThreadItem({
          threadId,
          title: "Conversation",
          detail: pending.text,
        });
        const history = sql<{
          readonly id: string;
          readonly key: string;
          readonly requestId: string;
          readonly createdAt: string;
          readonly deliveredAt: string | null;
        }>`
        SELECT notice_id AS id, dedupe_key AS key, request_id AS requestId,
          created_at AS createdAt, delivered_at AS deliveredAt
        FROM voice_notice_ledger WHERE notice_id = ${pending.id}
      `;
        const originalHistory = yield* history;
        assert.isNotNull(originalHistory[0]?.deliveredAt);
        const neutralDetail =
          kind === "input"
            ? "The question was answered or closed."
            : "The approval request was answered or closed.";

        yield* store.reconcileRequestNotices([]);
        assert.deepStrictEqual(yield* store.pendingRequestNotices(10), []);
        assert.strictEqual(
          (yield* store.listAgenda({ status: "open" })).find((item) => item.id === agenda.id)
            ?.detail,
          neutralDetail,
        );

        yield* store.reconcileRequestNotices([{ threadId, requestId }]);
        assert.deepStrictEqual(
          (yield* store.pendingRequestNotices(10)).map((notice) => [notice.id, notice.requestId]),
          [[pending.id, requestId]],
        );
        assert.strictEqual(
          (yield* store.listAgenda({ status: "open" })).find((item) => item.id === agenda.id)
            ?.detail,
          pending.text,
        );
        assert.deepStrictEqual(yield* store.undeliveredNotices(10), []);
        assert.deepStrictEqual(yield* history, originalHistory);
        assert.isFalse(yield* store.recordNotice({ ...pending, id: `${kind}-duplicate` }));

        yield* store.reconcileRequestNotices([]);
        yield* store.recordNotice({
          ...requestNotice({
            id: `${kind}-absent`,
            threadId,
            requestId: RuntimeRequestId.make(`${kind}:absent`),
            kind,
            createdAt: "2026-09-30T10:00:00.000Z",
          }),
          text: pending.text,
        });
        yield* store.reconcileRequestNotices([{ threadId, requestId }]);
        assert.strictEqual(
          (yield* store.listAgenda({ status: "open" })).find((item) => item.id === agenda.id)
            ?.detail,
          pending.text,
        );
        assert.deepStrictEqual(
          (yield* store.pendingRequestNotices(10)).map((notice) => notice.id),
          [pending.id],
        );

        yield* store.resolveRequestNotice(threadId, requestId);
        yield* store.reconcileRequestNotices([]);
        assert.deepStrictEqual(yield* store.pendingRequestNotices(10), []);
        assert.strictEqual(
          (yield* store.listAgenda({ status: "open" })).find((item) => item.id === agenda.id)
            ?.detail,
          neutralDetail,
        );
        assert.deepStrictEqual(yield* history, originalHistory);
      }
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "restoring requests preserves completion, failure, newer, and other-kind agenda details",
  () =>
    Effect.gen(function* () {
      const store = yield* VoiceStore;
      const requests = [
        { kind: "input" as const, detail: "Thread finished." },
        { kind: "approval" as const, detail: "Thread failed." },
        { kind: "input" as const, detail: "A newer question needs an answer." },
        { kind: "approval" as const, detail: "The question was answered or closed." },
      ].map((input, index) => ({
        ...input,
        threadId: ThreadId.make(`thread-restored-${index}`),
        requestId: RuntimeRequestId.make(`request-restored-${index}`),
      }));
      for (const [index, input] of requests.entries()) {
        const notice = requestNotice({
          id: `restored-${index}`,
          threadId: input.threadId,
          requestId: input.requestId,
          kind: input.kind,
          createdAt: `2026-09-30T10:00:0${index}.000Z`,
        });
        yield* store.recordNotice(notice);
        yield* store.openThreadItem({
          threadId: input.threadId,
          title: "Conversation",
          detail: notice.text,
        });
      }
      yield* store.reconcileRequestNotices([]);
      for (const input of requests) {
        yield* store.openThreadItem({
          threadId: input.threadId,
          title: "Conversation",
          detail: input.detail,
        });
      }
      yield* store.reconcileRequestNotices(requests);
      const open = yield* store.listAgenda({ status: "open" });
      assert.strictEqual((yield* store.pendingRequestNotices(10)).length, requests.length);
      for (const input of requests) {
        assert.strictEqual(
          open.find((item) => item.threadId === input.threadId)?.detail,
          input.detail,
        );
      }
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("migrates legacy request keys using exact thread prefixes and kind suffixes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrate(1);
    const threadId = ThreadId.make("thread:request:Ω_%:input");
    const requestId = RuntimeRequestId.make("request:request:λ:approval:input");
    const createdAt = "2026-09-30T10:00:00.000Z";
    const deliveredAt = "2026-09-30T10:00:01.000Z";
    const legacy = [
      { id: "input", kind: "input", key: `${threadId}:request:${requestId}:input`, requestId },
      {
        id: "approval",
        kind: "approval",
        key: `${threadId}:request:${requestId}:approval`,
        requestId,
      },
      { id: "unknown", kind: "input", key: "legacy-input", requestId: null },
      {
        id: "wrong-prefix",
        kind: "input",
        key: `other:request:${requestId}:input`,
        requestId: null,
      },
      {
        id: "wrong-suffix",
        kind: "input",
        key: `${threadId}:request:${requestId}:approval:extra`,
        requestId: null,
      },
      {
        id: "wrong-kind",
        kind: "approval",
        key: `${threadId}:request:${requestId}:mismatched:input`,
        requestId: null,
      },
      { id: "empty", kind: "input", key: `${threadId}:request::input`, requestId: null },
      {
        id: "completed",
        kind: "completed",
        key: `${threadId}:request:${requestId}:completed`,
        requestId: null,
      },
    ];
    for (const row of legacy) {
      yield* sql`
        INSERT INTO voice_notice_ledger
          (notice_id, dedupe_key, kind, thread_id, thread_title, text, created_at, delivered_at)
        VALUES (${row.id}, ${row.key}, ${row.kind}, ${threadId}, 'Legacy thread', 'Legacy notice',
          ${createdAt}, ${deliveredAt})
      `;
    }
    assert.deepStrictEqual(yield* migrate(2), [[2, "VoiceNoticeRequests"]]);
    assert.deepStrictEqual(yield* migrate(2), []);
    const migrated = yield* sql<{
      readonly id: string;
      readonly key: string;
      readonly requestId: string | null;
      readonly resolvedAt: string | null;
      readonly createdAt: string;
      readonly deliveredAt: string | null;
    }>`
      SELECT notice_id AS id, dedupe_key AS key, request_id AS requestId, resolved_at AS resolvedAt,
        created_at AS createdAt, delivered_at AS deliveredAt
      FROM voice_notice_ledger ORDER BY rowid
    `;
    assert.deepStrictEqual(
      migrated,
      legacy.map((row) => ({
        id: row.id,
        key: row.key,
        requestId: row.requestId,
        resolvedAt: null,
        createdAt,
        deliveredAt,
      })),
    );

    yield* Effect.gen(function* () {
      const store = yield* VoiceStore;
      assert.strictEqual((yield* store.pendingRequestNotices(20)).length, 7);
      yield* store.resolveRequestNotice(threadId, requestId);
      yield* store.reconcileRequestNotices([]);
      assert.deepStrictEqual(yield* store.pendingRequestNotices(20), []);
      assert.deepStrictEqual(
        (yield* store.recentNotices(20)).map((n) => [n.id, n.requestId]),
        [["completed", undefined]],
      );
    }).pipe(Effect.provide(StoreLayer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
