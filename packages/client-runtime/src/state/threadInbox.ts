import { threadBotName, threadOwnerBotName, type BotName } from "@t3tools/contracts";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { toSortableTimestamp } from "./threadSort.ts";

type WorkingThreadInput = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
>;

export function isThreadWorking(thread: WorkingThreadInput): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.pendingSubagentRequest != null) return false;
  if (!threadRuntimeIsActive(thread.runtime) && thread.runtime?.status !== "idle") return false;
  return !hasReadyPlan(thread);
}

/** A plan-mode thread whose run settled with a proposed plan is waiting for
    the user to implement or revise it. */
function hasReadyPlan(thread: WorkingThreadInput): boolean {
  const run = thread.latestRun;
  const runSettled =
    run !== null &&
    run.status !== "preparing" &&
    run.status !== "queued" &&
    run.status !== "starting" &&
    run.status !== "running" &&
    run.status !== "waiting" &&
    thread.runtime?.activeRunId !== run.runId;
  return thread.interactionMode === "plan" && thread.hasActionableProposedPlan && runSettled;
}

type InboxThreadInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "unsettledAt" | "latestRun"
>;

export function sortInboxThreadsByReturn<T extends InboxThreadInput>(
  threads: readonly T[],
  observedReturnAt?: (thread: T) => number | undefined,
): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0,
        observedReturnAt?.(thread) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

type WorkingSortInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "latestRun" | "latestUserAuthoredMessageAt"
>;

export function sortWorkingThreadsBySend<T extends WorkingSortInput>(threads: readonly T[]): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(
          (thread.latestUserAuthoredMessageAt === undefined
            ? thread.latestRun?.requestedAt
            : thread.latestUserAuthoredMessageAt) ?? undefined,
        ) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

/** The bot whose shelf an inbox thread folds into, or null for the inbox.
    Threads a bot launched skip the inbox and the Working section until they
    need the user: a pending approval, question, or ready plan brings one back
    to the inbox until it is answered. Pins, snoozes, and settlement still win. */
export function botShelfName(
  thread: Pick<EnvironmentThreadShell, "id"> & WorkingThreadInput,
): BotName | null {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput || hasReadyPlan(thread)) {
    return null;
  }
  return threadBotName(thread.id);
}

/** The Bots section groups rows by bot, then lists each bot's threads like
    the Working section: newest send first. */
export function sortBotThreads<T extends WorkingSortInput>(threads: readonly T[]): T[] {
  // sortWorkingThreadsBySend returns a fresh array, and sort is stable.
  return sortWorkingThreadsBySend(threads).sort((left, right) =>
    (threadBotName(left.id) ?? "").localeCompare(threadBotName(right.id) ?? ""),
  );
}

/** Projects only bots work in, as `environmentId:projectId` keys: every
    unarchived thread is a bot's or a subagent of one. Project pickers leave
    them out. A project with no threads, or one the user also works in, is not
    a bot project. */
export function botProjectKeys(
  threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "archivedAt" | "environmentId" | "id" | "projectId"> &
      Parameters<typeof threadOwnerBotName>[0]
  >,
): ReadonlySet<string> {
  const botOnly = new Map<string, boolean>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const key = `${thread.environmentId}:${thread.projectId}`;
    const isBot = threadOwnerBotName(thread) !== null;
    botOnly.set(key, (botOnly.get(key) ?? true) && isBot);
  }
  return new Set([...botOnly].filter(([, isBot]) => isBot).map(([key]) => key));
}

/** A row's project label, led by the bot's name on threads a bot launched,
    so bot work stays recognizable wherever it lists. */
export function threadProjectLabel(
  thread: Pick<EnvironmentThreadShell, "id">,
  projectName: string | null,
): string | null {
  const bot = threadBotName(thread.id);
  if (bot === null) return projectName;
  return projectName === null ? bot : `${bot} · ${projectName}`;
}

function sortNewestFirst<T extends Pick<EnvironmentThreadShell, "id" | "environmentId">>(
  threads: readonly T[],
  timestamps: ReadonlyMap<T, number>,
): T[] {
  return [...threads].sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

/**
 * Keep one at module scope so the inbox order survives routes that unmount the
 * list. Call `observe` with every thread shell on each list rebuild, or with
 * null to reset while the beta is off.
 */
export function createInboxReturnTracker() {
  const keyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
    `${thread.environmentId}:${thread.id}`;
  let lastWorkingKeys: ReadonlySet<string> | null = null;
  const returns = new Map<string, number>();
  return {
    observe(threads: ReadonlyArray<WorkingThreadInput & InboxThreadInput> | null): void {
      if (threads === null) {
        lastWorkingKeys = null;
        returns.clear();
        return;
      }
      const working = new Set<string>();
      const present = new Set<string>();
      for (const thread of threads) {
        const key = keyOf(thread);
        present.add(key);
        if (isThreadWorking(thread)) working.add(key);
      }
      for (const key of returns.keys()) {
        if (!present.has(key)) returns.delete(key);
      }
      // @effect-diagnostics-next-line globalDate:off
      const at = Date.now();
      for (const key of lastWorkingKeys ?? []) {
        if (present.has(key) && !working.has(key)) returns.set(key, at);
      }
      lastWorkingKeys = working;
    },
    returnedAt: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
      returns.get(keyOf(thread)),
  };
}
