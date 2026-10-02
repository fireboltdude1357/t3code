import type {
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ShellThreadStatus,
  RunId,
  RuntimeRequestId,
  ThreadId,
  VoiceNotice,
  VoiceNoticeKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * What the policy needs to know about the event's thread. The caller sets
 * `ignored` for threads the user should never hear about: voice session
 * threads, subagent or child threads, and archived threads.
 */
export interface VoiceThreadInfo {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly ignored: boolean;
}

/** A notice before it gets an id and timestamp. `agenda` says what to do with the thread's agenda item. */
export interface VoiceNoticeDraft {
  readonly kind: VoiceNoticeKind;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly text: string;
  readonly dedupeKey: string;
  readonly agenda: "open" | "close" | "none";
  readonly requestId?: RuntimeRequestId;
}

/** Higher is spoken first. */
export const NOTICE_PRIORITY: Record<VoiceNoticeKind, number> = {
  approval: 4,
  failed: 3,
  input: 2,
  completed: 1,
};

const NOTICE_TEXT: Record<VoiceNoticeKind, (title: string) => string> = {
  approval: (title) => `${title} needs an approval.`,
  failed: (title) => `${title} failed.`,
  input: (title) => `${title} is waiting on you.`,
  completed: (title) => `${title} finished.`,
};

const draft = (
  thread: VoiceThreadInfo,
  kind: VoiceNoticeKind,
  subjectKey: string,
): VoiceNoticeDraft => ({
  kind,
  threadId: thread.threadId,
  threadTitle: thread.title,
  text: NOTICE_TEXT[kind](thread.title),
  dedupeKey: `${thread.threadId}:${subjectKey}:${kind}`,
  // Every notice leaves the thread on the agenda so the orchestrator comes
  // back to it; opening is an upsert, so a later notice just refreshes the
  // item. Only the conversation (code or agent tools) closes it.
  agenda: "open",
});

/**
 * A run that just reached `status`. `completed` and `failed` are announced.
 * `interrupted`, `cancelled` and `rolled_back` are not: the user (or the
 * orchestrator on their behalf) stopped the run, so telling them is noise.
 * `waiting` is not either: in orchestration-v2 it means the agent turn is over
 * and background work is draining, and the run reaches `completed` afterwards.
 */
export function noticeForRun(
  runId: RunId,
  status: OrchestrationV2ShellThreadStatus,
  thread: VoiceThreadInfo,
): VoiceNoticeDraft | undefined {
  if (thread.ignored || (status !== "completed" && status !== "failed")) return undefined;
  return draft(thread, status, `run:${runId}`);
}

/**
 * A pending runtime request: `user_input` requests are `input`, every other
 * kind (command, file change, permission, MCP elicitation, tool call, auth
 * refresh) is `approval`. Settled requests return nothing.
 */
export function noticeForRequest(
  request: OrchestrationV2RuntimeRequest,
  thread: VoiceThreadInfo,
): VoiceNoticeDraft | undefined {
  if (thread.ignored || request.status !== "pending") return undefined;
  return {
    ...draft(thread, request.kind === "user_input" ? "input" : "approval", `request:${request.id}`),
    requestId: request.id,
  };
}

const MAX_BATCH_ITEMS = 6;

/**
 * Builds the one line the voice model speaks for a batch of notices.
 * Highest priority first, then oldest first; one sentence per thread and
 * kind. Returns an empty string for an empty batch. When to speak it is the
 * orchestrator's call, not the model's.
 */
export function composeNoticeBatch(notices: ReadonlyArray<VoiceNotice>): string {
  const seen = new Set<string>();
  const unique = notices
    .toSorted(
      (a, b) =>
        NOTICE_PRIORITY[b.kind] - NOTICE_PRIORITY[a.kind] ||
        DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
    )
    .filter((notice) => {
      const key = `${notice.threadId}:${notice.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (unique.length === 0) return "";

  const sentences = unique.slice(0, MAX_BATCH_ITEMS).map((notice) => notice.text);
  const hidden = unique.length - MAX_BATCH_ITEMS;
  if (hidden > 0) sentences.push(`And ${hidden} more.`);
  return ["Update from T3:", ...sentences].join(" ");
}

/** Whether a batch should be spoken soon, rather than at a long pause. */
export const isUrgentBatch = (notices: ReadonlyArray<VoiceNotice>): boolean =>
  notices.some((notice) => notice.kind !== "completed");
