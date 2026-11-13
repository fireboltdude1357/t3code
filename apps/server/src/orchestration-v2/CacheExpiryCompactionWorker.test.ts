import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  cacheExpiryCompactionCommand,
  type CacheExpiryCompactionCandidate,
} from "./CacheExpiryCompactionWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const reportedAt = Date.parse("2026-10-12T10:00:00.000Z");
const minutes = (count: number) => count * 60_000;

const claude: CacheExpiryCompactionCandidate = {
  threadId: ThreadId.make("thread:cache"),
  providerTurnId: ProviderTurnId.make("provider-turn:cache"),
  driver: ProviderDriverKind.make("claudeAgent"),
  usedTokens: 180_000,
  usageUpdatedAt: "2026-10-12T10:00:00.000Z",
  promptCacheTtlMs: minutes(60),
};
const codex: CacheExpiryCompactionCandidate = {
  ...claude,
  driver: ProviderDriverKind.make("codex"),
  promptCacheTtlMs: undefined,
};

it("compacts a large Claude thread just before its reported cache expires", () => {
  assert.isNull(cacheExpiryCompactionCommand(claude, 150_000, reportedAt + minutes(53)));
  const command = cacheExpiryCompactionCommand(claude, 150_000, reportedAt + minutes(54));
  assert.deepInclude(command, {
    type: "message.dispatch",
    threadId: claude.threadId,
    text: "/compact",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
    cacheExpiryCompactionOfProviderTurnId: claude.providerTurnId,
  });
  // Every sweep inside the window produces the same command, so the receipt dedupes it.
  assert.deepEqual(
    cacheExpiryCompactionCommand(claude, 150_000, reportedAt + minutes(59)),
    command,
  );
  // Once the cache is cold, compacting first is the composer's Compact chip's call.
  assert.isNull(cacheExpiryCompactionCommand(claude, 150_000, reportedAt + minutes(60)));
});

it("follows Claude's 5 minute cache", () => {
  const shortCache = { ...claude, promptCacheTtlMs: minutes(5) };
  // The two minute floor covers a long response that arrived well after its request.
  assert.isNull(cacheExpiryCompactionCommand(shortCache, 150_000, reportedAt + minutes(2.9)));
  assert.isNotNull(cacheExpiryCompactionCommand(shortCache, 150_000, reportedAt + minutes(3)));
  assert.isNull(cacheExpiryCompactionCommand(shortCache, 150_000, reportedAt + minutes(5)));
});

it("assumes Codex's default 30 minute cache", () => {
  assert.isNull(cacheExpiryCompactionCommand(codex, 150_000, reportedAt + minutes(26.9)));
  assert.isNotNull(cacheExpiryCompactionCommand(codex, 150_000, reportedAt + minutes(27)));
  assert.isNull(cacheExpiryCompactionCommand(codex, 150_000, reportedAt + minutes(30)));
});

it("leaves small, unknown and unsupported contexts alone", () => {
  const due = reportedAt + minutes(55);
  assert.isNull(cacheExpiryCompactionCommand(claude, null, due));
  assert.isNull(cacheExpiryCompactionCommand({ ...claude, usedTokens: 149_999 }, 150_000, due));
  assert.isNull(cacheExpiryCompactionCommand({ ...claude, promptCacheTtlMs: undefined }, 1, due));
  assert.isNull(
    cacheExpiryCompactionCommand({ ...codex, driver: ProviderDriverKind.make("cursor") }, 1, due),
  );
  assert.isNull(cacheExpiryCompactionCommand({ ...claude, usageUpdatedAt: "not a date" }, 1, due));
});

it("compacts once per provider turn", () => {
  const due = reportedAt + minutes(55);
  const first = cacheExpiryCompactionCommand(claude, 150_000, due);
  const next = cacheExpiryCompactionCommand(
    { ...claude, providerTurnId: ProviderTurnId.make("provider-turn:next") },
    150_000,
    due,
  );
  if (first?.type !== "message.dispatch" || next?.type !== "message.dispatch") {
    assert.fail("expected a dispatch for both provider turns");
  }
  assert.notEqual(first.commandId, next.commandId);
  assert.notEqual(first.messageId, next.messageId);
});

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: the compaction run is created but never reaches a provider.
const layerOrchestrator = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "cache-expiry-compaction" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("drops a compaction the thread no longer qualifies for and keeps user state", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:cache-expiry-dispatch");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:cache-expiry-dispatch"),
      title: "Cache expiry dispatch",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send"),
      threadId,
      messageId: MessageId.make("message:cache-expiry-dispatch"),
      text: "keep going",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    // The provider finishes a large turn.
    const now = yield* DateTime.now;
    const started = yield* orchestrator.getThreadProjection(threadId);
    const run = started.runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:cache-expiry-dispatch:completed"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", startedAt: now, completedAt: now },
    });
    yield* projections.apply({
      id: EventId.make("event:cache-expiry-dispatch:provider-turn"),
      type: "provider-turn.updated",
      threadId,
      nodeId: run.rootNodeId!,
      driver: adapter.driver,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make("provider-turn:cache-expiry-dispatch"),
        providerThreadId: run.providerThreadId!,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: now,
        completedAt: now,
        tokenUsage: { usedTokens: 180_000, updatedAt: DateTime.formatIso(now) },
      },
    });
    const [candidate] = yield* projections.getCacheExpiryCompactionCandidates({
      now,
      minTokens: 150_000,
    });
    const command = cacheExpiryCompactionCommand(
      candidate!,
      150_000,
      DateTime.toEpochMillis(now) + minutes(28),
    );
    if (command?.type !== "message.dispatch") return assert.fail("expected a compaction");
    const userActivityAt = ProjectionStore.threadShellFromProjection(
      yield* orchestrator.getThreadProjection(threadId),
    ).latestUserAuthoredMessageAt;
    yield* TestClock.adjust("28 minutes");

    // Snoozed after the sweep read it: the compaction neither runs nor wakes the thread.
    const snoozedUntil = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
    yield* orchestrator.dispatch({
      type: "thread.snooze",
      commandId: CommandId.make("snooze"),
      threadId,
      snoozedUntil,
    });
    yield* orchestrator.dispatch({ ...command, commandId: CommandId.make("compact:snoozed") });
    const snoozed = yield* orchestrator.getThreadProjection(threadId);
    assert.lengthOf(snoozed.runs, 1);
    assert.isNotNull(snoozed.thread.snoozedUntil);

    yield* orchestrator.dispatch({
      type: "thread.unsnooze",
      commandId: CommandId.make("unsnooze"),
      threadId,
      reason: "user",
    });
    // The user pinned the thread active; compaction is not activity that resets it.
    const unsnoozed = (yield* orchestrator.getThreadProjection(threadId)).thread;
    yield* projections.apply({
      id: EventId.make("event:cache-expiry-dispatch:active"),
      type: "thread.metadata-updated",
      threadId,
      occurredAt: now,
      payload: { ...unsnoozed, settledOverride: "active" },
    });
    yield* orchestrator.dispatch(command);
    const compacting = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(compacting.thread.settledOverride, "active");
    assert.deepEqual(
      compacting.runs.map((candidate) => candidate.userMessageId),
      [run.userMessageId, command.messageId],
    );
    assert.deepEqual(
      ProjectionStore.threadShellFromProjection(compacting).latestUserAuthoredMessageAt,
      userActivityAt,
    );
  }).pipe(Effect.provide(layerOrchestrator)),
);
