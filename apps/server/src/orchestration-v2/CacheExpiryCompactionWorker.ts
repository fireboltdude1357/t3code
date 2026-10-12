import { CommandId, MessageId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export type CacheExpiryCompactionCandidate =
  ProjectionStore.ProjectionCacheExpiryCompactionCandidate;

// Codex sends no cache lifetime, so OpenAI's default applies: at least 30
// minutes on current models. Claude reports its own (5 minutes or 1 hour).
const CODEX_PROMPT_CACHE_TTL_MS = 30 * 60_000;

function promptCacheTtlMs(candidate: CacheExpiryCompactionCandidate): number | undefined {
  if (candidate.driver === "claudeAgent") return candidate.promptCacheTtlMs;
  if (candidate.driver === "codex") return candidate.promptCacheTtlMs ?? CODEX_PROMPT_CACHE_TTL_MS;
  return undefined;
}

/**
 * `/compact` for a large idle thread whose prompt cache is about to expire.
 * Compacting while the cache is warm summarizes the history at cached-input
 * prices, so the next turn re-reads a short context instead of the full one.
 */
export function cacheExpiryCompactionCommand(
  candidate: CacheExpiryCompactionCandidate,
  minTokens: number | null,
  nowMs: number,
): OrchestrationV2Command | null {
  if (minTokens === null || candidate.usedTokens < minTokens) return null;
  const ttlMs = promptCacheTtlMs(candidate);
  const reportedAtMs = Date.parse(candidate.usageUpdatedAt);
  if (ttlMs === undefined || !Number.isFinite(reportedAtMs)) return null;
  // Leave time for a stopped provider to resume before the cache is gone.
  const leadMs = Math.max(60_000, ttlMs / 10);
  const idleMs = nowMs - reportedAtMs;
  if (idleMs < ttlMs - leadMs || idleMs >= ttlMs) return null;
  const identity = `${candidate.threadId}:${candidate.providerTurnId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`cache-expiry-compact:${identity}`),
    messageId: MessageId.make(`cache-expiry-compact:${identity}`),
    threadId: candidate.threadId,
    text: "/compact",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("CacheExpiryCompactionWorker.sweep")(function* () {
    const minTokens = (yield* settings.getSettings).cacheExpiryCompactionMinTokens;
    if (minTokens === null) return;
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const candidates = yield* projections.getCacheExpiryCompactionCandidates({ now, minTokens });
    for (const candidate of candidates) {
      const command = cacheExpiryCompactionCommand(candidate, minTokens, nowMs);
      if (command === null) continue;
      yield* threads.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.cache-expiry-compaction.dispatch-failed", {
            threadId: candidate.threadId,
            cause,
          }),
        ),
      );
    }
  });
});

// Due work is derived from persisted usage reports, so restarts need no timers.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("cache-expiry-compaction", sweep());
  }),
);
