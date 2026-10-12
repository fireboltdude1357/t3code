import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderTurnId, ThreadId } from "@t3tools/contracts";

import {
  cacheExpiryCompactionCommand,
  type CacheExpiryCompactionCandidate,
} from "./CacheExpiryCompactionWorker.ts";

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
    createdBy: "user",
    creationSource: "server",
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
  assert.isNull(cacheExpiryCompactionCommand(shortCache, 150_000, reportedAt + minutes(3.9)));
  assert.isNotNull(cacheExpiryCompactionCommand(shortCache, 150_000, reportedAt + minutes(4)));
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
  assert.notEqual(first?.commandId, next?.commandId);
  assert.notEqual(first?.type === "message.dispatch" && first.messageId, undefined);
});
