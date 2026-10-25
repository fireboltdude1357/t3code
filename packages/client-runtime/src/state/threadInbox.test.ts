import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botProjectKeys,
  botShelfName,
  createInboxReturnTracker,
  sortBotThreads,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    const first = tracker.observe([thread("a", true), thread("b", false)]);
    expect(first(thread("a", true))).toBeUndefined();
    expect(first(thread("b", false))).toBeUndefined();

    const second = tracker.observe([thread("a", false), thread("b", false)]);
    expect(second(thread("a", false))).toBeDefined();
    expect(second(thread("b", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("a", false))).toBe(second(thread("a", false)));
    // An earlier observation keeps its answer, so lists built from it stay valid.
    expect(first(thread("a", false))).toBeUndefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});

describe("bot shelf", () => {
  it("keeps bot threads off the inbox until they need the user", () => {
    const bot = thread("bot:warden:cmd-1", true);
    expect(botShelfName(bot)).toBe("warden");
    expect(botShelfName({ ...bot, hasPendingApprovals: true })).toBeNull();
    expect(botShelfName({ ...bot, hasPendingUserInput: true })).toBeNull();
    expect(botShelfName(thread("cmd-1", true))).toBeNull();
    // A settled run with a proposed plan waits on the user to implement it.
    const planReady = {
      ...thread("bot:warden:cmd-2", false),
      interactionMode: "plan" as const,
      hasActionableProposedPlan: true,
      latestRun: {
        runId: RunId.make("run-1"),
        status: "completed" as const,
        requestedAt: "2026-06-01T00:00:00.000Z",
        startedAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-06-01T00:01:00.000Z",
        assistantMessageId: null,
      },
    };
    expect(botShelfName(planReady)).toBeNull();
    expect(botShelfName({ ...planReady, hasActionableProposedPlan: false })).toBe("warden");
  });

  it("groups threads by bot, newest send first within each bot", () => {
    const sent = (id: string, at: string) => ({
      ...thread(id, true),
      latestUserAuthoredMessageAt: at,
    });
    const sorted = sortBotThreads([
      sent("bot:warden:old", "2026-06-01T01:00:00.000Z"),
      sent("bot:ledger:only", "2026-06-01T00:30:00.000Z"),
      sent("bot:warden:new", "2026-06-01T02:00:00.000Z"),
    ]);
    expect(sorted.map((row) => row.id)).toEqual([
      "bot:ledger:only",
      "bot:warden:new",
      "bot:warden:old",
    ]);
  });
});

describe("botProjectKeys", () => {
  const projectThread = (projectId: string, id: string, rootThreadId = id, archived = false) => ({
    environmentId,
    projectId: ProjectId.make(projectId),
    id: ThreadId.make(id),
    lineage: { rootThreadId: ThreadId.make(rootThreadId) },
    archivedAt: archived ? "2026-06-01T00:00:00.000Z" : null,
  });

  it("marks projects where only bots and their subagents work", () => {
    const keys = botProjectKeys([
      projectThread("bot-only", "bot:medic:1"),
      projectThread("bot-only", "subagent-1", "bot:medic:1"),
      projectThread("mixed", "bot:medic:2"),
      projectThread("mixed", "user-1"),
      projectThread("user-only", "user-2"),
      projectThread("archived-user", "bot:medic:3"),
      projectThread("archived-user", "user-3", "user-3", true),
    ]);
    expect([...keys].toSorted()).toEqual(
      ["archived-user", "bot-only"].map((projectId) => `${environmentId}:${projectId}`),
    );
  });
});
