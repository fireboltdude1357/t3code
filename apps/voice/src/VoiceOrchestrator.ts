import {
  CommandId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type VoiceAgendaItem,
  type VoiceConfirmAction,
  type VoiceConfirmRequest,
  type VoiceNotice,
  type VoiceMcpApproveResult,
  type VoiceSessionEndReason,
  type VoiceSessionEvent,
  type VoiceSessionOpenInput,
  type VoiceSessionRespondInput,
  type VoiceSessionRespondResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { T3Client, type T3ThreadChange } from "./T3Client.ts";
import {
  confirmationReadback,
  makeVoiceConfirmationGate,
  sameConfirmationReadback,
  soundsSame,
  type VoiceSendMode,
} from "./VoiceConfirmation.ts";
import { buildBriefing } from "./VoiceBriefing.ts";
import {
  composeNoticeBatch,
  isUrgentBatch,
  noticeForRequest,
  noticeForRun,
  type VoiceNoticeDraft,
} from "./VoiceNotificationPolicy.ts";
import {
  type PreparedSessionThread,
  type RealtimeCall,
  VoiceSessionService,
} from "./VoiceSessionService.ts";
import { VoiceStore } from "./VoiceStore.ts";

/** A session thread with a live realtime generation. */
export interface LiveVoiceSession {
  readonly sessionThreadId: ThreadId;
  readonly generation: number;
  readonly focusThreadId: ThreadId | undefined;
}

/**
 * One per server. Owns the session lifecycle, watches every thread's events,
 * decides what to tell the user, and holds write actions until the user says
 * yes. Prompts only carry tone; this service owns state and policy.
 */
export interface VoiceOrchestratorShape {
  /** One generation. See `VoiceSessionOpenInput`. */
  readonly open: (input: VoiceSessionOpenInput) => Stream.Stream<VoiceSessionEvent>;
  /** The phone's Approve or Deny for a pending confirmation. */
  readonly respond: (input: VoiceSessionRespondInput) => Effect.Effect<VoiceSessionRespondResult>;
  /** The live session whose session thread is `threadId`, if any. */
  readonly proposeAction: (input: {
    readonly sessionThreadId?: ThreadId;
    readonly action: VoiceConfirmAction;
    readonly threadId?: ThreadId;
    readonly title: string;
    readonly detail: string;
    readonly execute: Effect.Effect<string>;
  }) => Effect.Effect<Option.Option<VoiceConfirmRequest>>;
  readonly pendingConfirmations: (
    sessionThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<VoiceConfirmRequest>>;
  readonly approveSpoken: (input: {
    readonly sessionThreadId: ThreadId;
    readonly requestId: string;
  }) => Effect.Effect<VoiceMcpApproveResult>;
  /**
   * Claims the user's spoken yes to `readback` (from `sendReadback`) for this
   * exact thread, text and mode, once. The first call only issues the send:
   * it returns false, and only a readback spoken after that can be answered.
   * Also false when that readback wasn't spoken and answered with a plain yes,
   * or when another issued send sounds the same.
   */
  readonly claimSpokenSend: (input: {
    readonly sessionThreadId: ThreadId;
    readonly threadId: ThreadId;
    readonly text: string;
    readonly mode: VoiceSendMode;
    readonly readback: string;
  }) => Effect.Effect<boolean>;
  readonly liveSession: (threadId: ThreadId) => Effect.Effect<Option.Option<LiveVoiceSession>>;
  /**
   * Shows an Approve/Deny card on the phone and waits for it. Resolves false
   * on Deny, on timeout, or when no generation is live.
   */
  readonly requestConfirmation: (input: {
    readonly action: VoiceConfirmAction;
    readonly threadId?: ThreadId;
    readonly title: string;
    readonly detail: string;
  }) => Effect.Effect<boolean>;
}

export class VoiceOrchestrator extends Context.Service<VoiceOrchestrator, VoiceOrchestratorShape>()(
  "@t3tools/voice/VoiceOrchestrator",
) {}

/**
 * The phone is asked to open the next generation after this long. A silent
 * session lasted 65 minutes; a talkative one fills context sooner.
 */
export const ROTATE_AFTER = Duration.minutes(40);
/** The next session thread is prepared this long before rotation. */
const PREWARM_LEAD = Duration.minutes(2);
/** Keep in step with the `expiresAt` shown on the card. */
const CONFIRM_TIMEOUT = Duration.minutes(2);
/** Transcript parts can split a reply, so spoken writes wait for two seconds without activity. */
const CONFIRM_QUIET = Duration.seconds(2);
/** Notices that arrive together are spoken as one batch. */
const NOTICE_BATCH_WINDOW = Duration.seconds(10);
const NOTICE_BATCH_MAX = 8;
/**
 * A batch is spoken once nobody has spoken for this long, so it lands in a
 * pause instead of over the user. Urgent news waits less, and nothing waits
 * past `NOTICE_MAX_WAIT`.
 */
const QUIET_BEFORE_URGENT = Duration.seconds(2);
const QUIET_BEFORE_ROUTINE = Duration.seconds(6);
const NOTICE_MAX_WAIT = Duration.seconds(90);
/** How far back the store is read for pending notices. */
const NOTICE_LOOKBACK = 500;
/** Older pending notices are dropped from a briefing as stale. */
const NOTICE_FRESH_HOURS = 2;
const BRIEFING_NOTICES = 20;
/** Thread items older than this are left out of briefings; topics never age out. */
const THREAD_AGENDA_FRESH_HOURS = 24;
const BRIEFING_AGENDA_ITEMS = 15;

/** Instructions for the realtime voice model. */
export const VOICE_SESSION_PROMPT = [
  "You are Tanner's voice orchestrator for all of his T3 Code threads. He may talk to you for hours while driving or walking. Be brief and conversational.",
  "Hand lookups, questions about threads, and any action to the background agent. It can see every thread; you cannot.",
  'Lines that start with "Update from T3:" are news about other threads, timed by the system for a pause. Say them briefly and let the user decide whether to dig in.',
  "When a tangent wraps up, come back to open agenda items from your briefing or the agent.",
  "To send or queue a message to a thread, hand the draft and thread to the background agent first. It returns the exact send readback. Speak that readback verbatim as your entire send question. Keep its opening, Send to or Queue for, the word Message before the draft, and its final question, Should I send it? or Should I queue it? Do not summarize, reorder, introduce, or paraphrase it. Then wait for the full user reply. After a clear yes, hand off so the agent can send. If the draft or thread changes, get the new readback and ask again.",
  "For launch, interrupt, or runtime approvals, ask the background agent for the pending action and its exact readback. Speak the returned readback verbatim as your entire approval question. Keep its opening action phrase and its final question, Do you approve this action? Do not summarize, reorder, introduce, or paraphrase it. Then wait for the full user reply. After a clear yes, hand off to call voice_approve for that request. A phone Approve tap is also available. Never treat a partial yes followed by an objection as approval.",
  "You cannot do anything yourself. Never say something was sent, launched or approved until the agent confirms it.",
].join("\n");

/**
 * What the backing agent needs that the call transcript won't tell it: which
 * thread "this thread" means, and the open agenda ids its tools act on.
 */
const agentBriefing = (
  focus: { readonly id: ThreadId; readonly title: string } | undefined,
  agenda: ReadonlyArray<VoiceAgendaItem>,
) =>
  [
    focus === undefined
      ? "The user opened this session from the home screen, not from a thread."
      : `The user opened this session from the thread "${focus.title}" (threadId ${focus.id}). "This thread" means that one.`,
    agenda.length === 0
      ? "The agenda is empty."
      : `Open agenda items: ${agenda.map((item) => `${item.id} "${item.title}"`).join("; ")}.`,
  ].join("\n");

interface GenerationEnd {
  readonly reason: VoiceSessionEndReason;
  readonly message?: string;
}

interface Generation extends LiveVoiceSession {
  readonly supportsRequestNotices: boolean;
  readonly call: RealtimeCall;
  readonly events: Queue.Queue<VoiceSessionEvent>;
  readonly end: Deferred.Deferred<GenerationEnd>;
  /** Epoch millis of the last transcript delta from either side. */
  readonly lastActivity: Ref.Ref<number>;
  /**
   * Epoch millis of the last user speech. Spoken approvals wait for this to go
   * quiet so the user's reply is complete; the voice model's own filler ("one
   * moment") must not void a yes.
   */
  readonly lastUserActivity: Ref.Ref<number>;
}

interface State {
  readonly live: Generation | undefined;
  /** A session thread prepared ahead of rotation, taken by the next open. */
  readonly warm: PreparedSessionThread | undefined;
}

export const make = Effect.gen(function* () {
  const t3 = yield* T3Client;
  const sessions = yield* VoiceSessionService;
  const store = yield* VoiceStore;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const scope = yield* Effect.scope;
  const gate = makeVoiceConfirmationGate();
  const state = yield* Ref.make<State>({ live: undefined, warm: undefined });
  const noticeLock = yield* Semaphore.make(1);
  const confirmations = yield* Ref.make(
    new Map<
      string,
      {
        readonly request: VoiceConfirmRequest;
        readonly decided: Deferred.Deferred<boolean>;
        readonly createdAt: DateTime.Utc;
        readonly generation: number;
        readonly execute: Effect.Effect<string>;
      }
    >(),
  );
  /** Sends whose readback voice_send has handed out, keyed by thread, mode and text. */
  const issuedSends = yield* Ref.make(
    new Map<
      string,
      {
        readonly generation: number;
        readonly readback: string;
        readonly issuedAt: DateTime.Utc;
      }
    >(),
  );
  const approvalAttempts = yield* Ref.make(
    new Map<
      string,
      {
        readonly generation: number;
        readonly decided: Deferred.Deferred<boolean>;
        readonly finished: Deferred.Deferred<void>;
      }
    >(),
  );
  const approvalKey = (threadId: ThreadId, requestId: OrchestrationV2RuntimeRequest["id"]) =>
    `${threadId.length}:${threadId}${requestId}`;
  const offerToLive = (event: VoiceSessionEvent) =>
    Ref.get(state).pipe(
      Effect.flatMap(({ live }) =>
        live === undefined ? Effect.void : Queue.offer(live.events, event).pipe(Effect.asVoid),
      ),
    );

  const currentSession = (sessionThreadId: ThreadId) =>
    Ref.get(state).pipe(
      Effect.map(({ live }) => (live?.sessionThreadId === sessionThreadId ? live : undefined)),
    );

  const resolveConfirmation = (requestId: string, approved: boolean) =>
    Effect.gen(function* () {
      const pending = yield* Ref.modify(confirmations, (current) => {
        const pending = current.get(requestId);
        const updated = new Map(current);
        updated.delete(requestId);
        return [pending, updated];
      });
      if (pending === undefined) return { accepted: false, completed: false, completion: "" };
      const now = yield* DateTime.now;
      const live = (yield* Ref.get(state)).live;
      const allowed =
        approved &&
        live?.generation === pending.generation &&
        DateTime.toEpochMillis(now) < DateTime.toEpochMillis(pending.request.expiresAt);
      let completion = "";
      const completed =
        allowed &&
        (yield* pending.execute.pipe(
          Effect.map((message) => {
            completion = message;
            return true;
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("voice-session.action-failed", { requestId, cause }).pipe(
              Effect.as(false),
            ),
          ),
        ));
      yield* Deferred.succeed(pending.decided, completed);
      yield* offerToLive({ type: "confirm_resolved", requestId, approved: completed });
      if (allowed) {
        const active = (yield* Ref.get(state)).live;
        if (active?.generation === pending.generation) {
          yield* active.call
            .appendSpeech(
              completed
                ? `Update from T3: ${completion}`
                : "Update from T3: The approved action failed. Check the thread before trying again.",
            )
            .pipe(Effect.ignore);
        }
      }
      return { accepted: true, completed, completion };
    });

  const beginConfirmation = (
    input: Parameters<VoiceOrchestratorShape["proposeAction"]>[0],
    existingDecision?: Deferred.Deferred<boolean>,
  ) =>
    Effect.gen(function* () {
      const live = (yield* Ref.get(state)).live;
      if (
        live === undefined ||
        (input.sessionThreadId !== undefined && input.sessionThreadId !== live.sessionThreadId)
      )
        return Option.none();
      const createdAt = yield* DateTime.now;
      const id = `voice-confirm:${yield* uuid}`;
      const decided = existingDecision ?? (yield* Deferred.make<boolean>());
      const request: VoiceConfirmRequest = {
        id,
        action: input.action,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        title: input.title,
        detail: input.detail,
        expiresAt: DateTime.add(createdAt, { minutes: 2 }),
      };
      yield* Ref.update(confirmations, (current) =>
        new Map(current).set(id, {
          request,
          decided,
          createdAt,
          generation: live.generation,
          execute: input.execute,
        }),
      );
      yield* offerToLive({ type: "confirm", request });
      yield* Effect.sleep(CONFIRM_TIMEOUT).pipe(
        Effect.andThen(resolveConfirmation(id, false)),
        Effect.forkIn(scope),
      );
      return Option.some({ request, decided });
    });

  const proposeAction: VoiceOrchestratorShape["proposeAction"] = (input) =>
    beginConfirmation(input).pipe(Effect.map(Option.map(({ request }) => request)));

  const requestConfirmation: VoiceOrchestratorShape["requestConfirmation"] = (input) =>
    Effect.gen(function* () {
      const pending = yield* beginConfirmation({
        ...input,
        execute: Effect.succeed("Action approved."),
      });
      return Option.isNone(pending) ? false : yield* Deferred.await(pending.value.decided);
    });

  const respond: VoiceOrchestratorShape["respond"] = ({ requestId, approved }) =>
    resolveConfirmation(requestId, approved).pipe(Effect.map(({ accepted }) => ({ accepted })));

  const pendingConfirmations: VoiceOrchestratorShape["pendingConfirmations"] = (sessionThreadId) =>
    Effect.gen(function* () {
      const live = yield* currentSession(sessionThreadId);
      if (live === undefined) return [];
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      return [...(yield* Ref.get(confirmations)).values()]
        .filter(
          (pending) =>
            pending.generation === live.generation &&
            DateTime.toEpochMillis(pending.request.expiresAt) > now,
        )
        .map(({ request }) => request);
    });

  const isSpokenQuiet = (live: Generation) =>
    Effect.gen(function* () {
      const current = (yield* Ref.get(state)).live;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      return (
        current === live &&
        now - (yield* Ref.get(live.lastUserActivity)) >= Duration.toMillis(CONFIRM_QUIET)
      );
    });

  const awaitSpokenQuiet = (live: Generation) =>
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const wait = (yield* Ref.get(live.lastUserActivity)) + Duration.toMillis(CONFIRM_QUIET) - now;
      if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
      // Further activity fails this attempt rather than starting an unbounded retry loop.
      return yield* isSpokenQuiet(live);
    });

  const claimSpokenSend: VoiceOrchestratorShape["claimSpokenSend"] = (input) =>
    Effect.gen(function* () {
      const live = yield* currentSession(input.sessionThreadId);
      if (live === undefined) return false;
      const now = yield* DateTime.now;
      // One issued send per thread and mode: a retry whose readback sounds the
      // same keeps its first issue time, so a yes already given still counts.
      // A different draft replaces it and needs a fresh readback and yes.
      const key = `${input.threadId.length}:${input.threadId}${input.mode}`;
      // Sends expire with their generation and after the confirmation timeout.
      const { issued, current } = yield* Ref.modify(issuedSends, (sends) => {
        const current = new Map(
          [...sends].filter(
            ([, send]) =>
              send.generation === live.generation &&
              DateTime.toEpochMillis(now) - DateTime.toEpochMillis(send.issuedAt) <
                Duration.toMillis(CONFIRM_TIMEOUT),
          ),
        );
        const existing = current.get(key);
        const issued =
          existing !== undefined && soundsSame(existing.readback, input.readback)
            ? existing
            : undefined;
        if (issued === undefined)
          current.set(key, {
            generation: live.generation,
            readback: input.readback,
            issuedAt: now,
          });
        return [{ issued, current }, current];
      });
      if (issued === undefined) return false;
      // Identical issued readbacks cannot be distinguished by a spoken yes.
      if (
        [...current].some(
          ([other, send]) => other !== key && soundsSame(send.readback, input.readback),
        )
      )
        return false;
      if (!(yield* awaitSpokenQuiet(live))) return false;
      const transcript = yield* store.recentTranscript(80);
      if (!(yield* isSpokenQuiet(live))) return false;
      const claimed = gate.claim({
        transcript,
        generation: live.generation,
        now: yield* DateTime.now,
        readback: issued.readback,
        notBefore: DateTime.makeUnsafe(DateTime.toEpochMillis(issued.issuedAt) + 1),
      });
      if (claimed)
        yield* Ref.update(issuedSends, (sends) => {
          const updated = new Map(sends);
          updated.delete(key);
          return updated;
        });
      return claimed;
    });

  const approveSpoken: VoiceOrchestratorShape["approveSpoken"] = (input) =>
    Effect.gen(function* () {
      const live = yield* currentSession(input.sessionThreadId);
      const pending = (yield* Ref.get(confirmations)).get(input.requestId);
      const quiet = live !== undefined && (yield* awaitSpokenQuiet(live));
      const now = yield* DateTime.now;
      if (
        live === undefined ||
        pending === undefined ||
        pending.generation !== live.generation ||
        DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(pending.request.expiresAt)
      ) {
        return { status: "unavailable", requestId: input.requestId };
      }
      const readback = confirmationReadback(pending.request);
      // Identical pending readbacks cannot be distinguished by a spoken yes.
      const matching = [...(yield* Ref.get(confirmations)).values()].filter(
        (candidate) =>
          candidate.generation === live.generation &&
          sameConfirmationReadback(candidate.request, pending.request),
      );
      const transcript = yield* store.recentTranscript(80);
      if (
        !quiet ||
        matching.length !== 1 ||
        !(yield* isSpokenQuiet(live)) ||
        !gate.claim({
          transcript,
          generation: live.generation,
          now,
          readback,
          notBefore: DateTime.makeUnsafe(DateTime.toEpochMillis(pending.createdAt) + 1),
        })
      ) {
        return {
          status: "needs_spoken_yes",
          requestId: input.requestId,
          instruction: `Nothing was approved. Read this action back word for word, wait for the user's complete reply and a fresh yes, then call voice_approve for this request. ${readback}`,
        };
      }
      const result = yield* resolveConfirmation(input.requestId, true);
      return result.completed
        ? { status: "approved", requestId: input.requestId, completion: result.completion }
        : { status: result.accepted ? "failed" : "unavailable", requestId: input.requestId };
    });

  /**
   * Subagents and archived threads are never announced. Session threads live
   * in the sidecar's own Codex, so T3 never reports them.
   */
  const infoOf = (threadId: ThreadId, shell: OrchestrationV2ThreadShell | null) => ({
    threadId,
    title: shell?.title ?? "A thread",
    ignored:
      shell === null ||
      shell.archivedAt !== null ||
      shell.lineage.relationshipToParent === "subagent",
  });
  const threadInfo = (threadId: ThreadId) =>
    t3.threadShell(threadId).pipe(Effect.map((shell) => infoOf(threadId, shell)));

  /**
   * A spoken or tapped yes for another thread's approval, answered in place.
   * The card shows what is being approved; a request with nothing to show
   * gets no card and stays for the user in its thread, as does a denial.
   */
  const confirmRuntimeApproval = (
    threadId: ThreadId,
    request: OrchestrationV2RuntimeRequest,
    threadTitle: string,
    generation: number,
    decided: Deferred.Deferred<boolean>,
  ) =>
    Effect.gen(function* () {
      const confirmation = yield* Effect.gen(function* () {
        const live = (yield* Ref.get(state)).live;
        if (
          live?.generation !== generation ||
          (yield* Deferred.isDone(decided)) ||
          request.responseCapability.type !== "live" ||
          (yield* threadInfo(threadId)).ignored
        )
          return Option.none();
        const providerSessionId = request.responseCapability.providerSessionId;
        const records = yield* t3.threadProjection(threadId);
        const currentRequest = records.runtimeRequests.find(
          (candidate) => candidate.id === request.id,
        );
        if (
          currentRequest?.status !== "pending" ||
          currentRequest.kind === "user_input" ||
          currentRequest.responseCapability.type !== "live" ||
          currentRequest.responseCapability.providerSessionId !== providerSessionId
        )
          return Option.none();
        const item = records.turnItems.find(
          (candidate) =>
            candidate.type === "approval_request" && candidate.requestId === request.id,
        );
        const prompt = item?.type === "approval_request" ? item.prompt?.trim() : undefined;
        if (prompt === undefined || prompt.length === 0) return Option.none();
        return yield* beginConfirmation(
          {
            sessionThreadId: live.sessionThreadId,
            action: "runtime_approval",
            threadId,
            title: `${threadTitle} needs an approval`,
            detail: prompt,
            execute: Effect.gen(function* () {
              const current = yield* t3.threadProjection(threadId);
              const liveRequest = current.runtimeRequests.find(
                (candidate) => candidate.id === request.id,
              );
              const currentItem = current.turnItems.find(
                (candidate) =>
                  candidate.type === "approval_request" && candidate.requestId === request.id,
              );
              const currentPrompt =
                currentItem?.type === "approval_request" ? currentItem.prompt?.trim() : undefined;
              if (
                (yield* Ref.get(state)).live?.generation !== generation ||
                (yield* Deferred.isDone(decided)) ||
                (yield* threadInfo(threadId)).ignored ||
                currentPrompt !== prompt ||
                liveRequest?.status !== "pending" ||
                liveRequest.kind === "user_input" ||
                liveRequest.responseCapability.type !== "live" ||
                liveRequest.responseCapability.providerSessionId !== providerSessionId
              ) {
                return yield* Effect.die("The runtime approval is no longer current.");
              }
              yield* t3.dispatch({
                type: "runtime-request.respond",
                commandId: CommandId.make(`voice-sidecar:approve:${yield* uuid}`),
                threadId,
                requestId: request.id,
                decision: "accept",
              });
              return `${threadTitle}'s runtime request was approved.`;
            }).pipe(noticeLock.withPermits(1), Effect.orDie),
          },
          decided,
        );
      }).pipe(noticeLock.withPermits(1));
      if (Option.isNone(confirmation)) return;
      yield* Deferred.await(decided).pipe(
        Effect.ensuring(resolveConfirmation(confirmation.value.request.id, false)),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("voice-session.approval-failed", { threadId, cause }),
      ),
    );

  /** One gate per request; a reconnect may retry an attempt that already ended. */
  const scheduleRuntimeApproval = (
    threadId: ThreadId,
    request: OrchestrationV2RuntimeRequest,
    threadTitle: string,
  ) =>
    Effect.gen(function* () {
      const { live } = yield* Ref.get(state);
      if (
        live === undefined ||
        request.status !== "pending" ||
        request.responseCapability.type !== "live" ||
        request.kind === "user_input"
      )
        return;
      const key = approvalKey(threadId, request.id);
      const previous = (yield* Ref.get(approvalAttempts)).get(key);
      if (
        previous !== undefined &&
        (previous.generation === live.generation || !(yield* Deferred.isDone(previous.finished)))
      )
        return;
      const attempt = {
        generation: live.generation,
        decided: yield* Deferred.make<boolean>(),
        finished: yield* Deferred.make<void>(),
      };
      yield* Ref.update(approvalAttempts, (current) => new Map(current).set(key, attempt));
      yield* Effect.forkDetach(
        confirmRuntimeApproval(
          threadId,
          request,
          threadTitle,
          attempt.generation,
          attempt.decided,
        ).pipe(Effect.ensuring(Deferred.succeed(attempt.finished, undefined))),
      );
    });

  const clearApprovalAttempt = (key: string) =>
    Effect.gen(function* () {
      const attempt = (yield* Ref.get(approvalAttempts)).get(key);
      yield* Ref.update(approvalAttempts, (current) => {
        const updated = new Map(current);
        updated.delete(key);
        return updated;
      });
      if (attempt !== undefined) yield* Deferred.succeed(attempt.decided, false);
    });

  const pendingNotices = yield* Queue.unbounded<VoiceNotice>();

  const recordDraft = (draft: VoiceNoticeDraft) =>
    Effect.gen(function* () {
      const notice: VoiceNotice = {
        id: `voice-notice:${yield* uuid}`,
        kind: draft.kind,
        threadId: draft.threadId,
        threadTitle: draft.threadTitle,
        ...(draft.requestId === undefined ? {} : { requestId: draft.requestId }),
        text: draft.text,
        createdAt: yield* DateTime.now,
      };
      if (!(yield* store.recordNotice({ ...notice, dedupeKey: draft.dedupeKey }))) return false;
      yield* store.openThreadItem({
        threadId: draft.threadId,
        title: draft.threadTitle,
        detail: draft.text,
      });
      yield* Queue.offer(pendingNotices, notice);
      return true;
    });

  const publishRequestNotices = Effect.gen(function* () {
    const { live } = yield* Ref.get(state);
    if (!live?.supportsRequestNotices) return;
    yield* Queue.offer(live.events, {
      type: "request_notices",
      notices: yield* store.pendingRequestNotices(BRIEFING_NOTICES),
    });
  });

  /** Rebuild attention cards from projections, including requests missed while offline. */
  const reconcileRequests = (scheduleApprovals = false) =>
    Effect.gen(function* () {
      const snapshot = yield* t3.shell;
      const pending: Parameters<typeof store.reconcileRequestNotices>[0][number][] = [];
      for (const shell of snapshot.threads) {
        if (shell.pendingRuntimeRequest === null) continue;
        const info = infoOf(shell.id, shell);
        if (info.ignored) continue;
        const records = yield* t3.threadProjection(shell.id);
        for (const request of records.runtimeRequests) {
          const draft = noticeForRequest(request, info);
          if (draft === undefined) continue;
          pending.push({ threadId: shell.id, requestId: request.id });
          yield* recordDraft(draft);
          if (scheduleApprovals) yield* scheduleRuntimeApproval(shell.id, request, info.title);
        }
      }
      yield* store.reconcileRequestNotices(pending);
      const pendingKeys = new Set(
        pending.map(({ threadId, requestId }) => approvalKey(threadId, requestId)),
      );
      for (const key of (yield* Ref.get(approvalAttempts)).keys()) {
        if (!pendingKeys.has(key)) yield* clearApprovalAttempt(key);
      }
    });

  /**
   * Turns one shell change into at most one recorded notice per subject. T3's
   * public shell stream carries each thread's latest run status and pending
   * request, so a change in either is the event; the ledger dedupes repeats.
   */
  const handleChange = ({ previous, thread }: T3ThreadChange) =>
    Effect.gen(function* () {
      // A thread first seen through a live update has no "before"; a reconnect
      // snapshot reports threads that appeared while away against an idle one.
      if (previous === undefined) return;
      const info = infoOf(thread.id, thread);
      const finished =
        thread.latestRunId !== null &&
        (thread.status === "completed" || thread.status === "failed") &&
        (previous.status !== thread.status || previous.latestRunId !== thread.latestRunId);
      if (finished && thread.latestRunId !== null) {
        const draft = noticeForRun(thread.latestRunId, thread.status, info);
        if (draft !== undefined) yield* recordDraft(draft);
      }
      const before = previous.pendingRuntimeRequest?.id;
      // An archived thread's request is no longer the user's to answer.
      const after = thread.archivedAt === null ? thread.pendingRuntimeRequest?.id : undefined;
      if (before === after) return;
      if (before !== undefined) {
        yield* clearApprovalAttempt(approvalKey(thread.id, before));
        yield* store.resolveRequestNotice(thread.id, before);
        yield* publishRequestNotices;
      }
      if (after === undefined || info.ignored) return;
      // The shell can trail the projection. Never revive an answered request.
      const records = yield* t3.threadProjection(thread.id);
      const request = records.runtimeRequests.find(
        (candidate) => candidate.id === after && candidate.status === "pending",
      );
      if (request === undefined) return;
      const draft = noticeForRequest(request, info);
      if (draft === undefined) return;
      yield* recordDraft(draft);
      yield* publishRequestNotices;
      yield* scheduleRuntimeApproval(thread.id, request, info.title);
    }).pipe(
      noticeLock.withPermits(1),
      Effect.catchCause((cause) => Effect.logWarning("voice-session.notice-failed", { cause })),
    );

  /** Waits until the call has been quiet for `quiet`, or `NOTICE_MAX_WAIT` passed. */
  const awaitPause = (live: Generation, quiet: Duration.Duration) =>
    Effect.gen(function* () {
      const deadline =
        DateTime.toEpochMillis(yield* DateTime.now) + Duration.toMillis(NOTICE_MAX_WAIT);
      while (true) {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        if (
          now >= deadline ||
          now - (yield* Ref.get(live.lastActivity)) >= Duration.toMillis(quiet)
        )
          return;
        yield* Effect.sleep(Duration.seconds(1));
      }
    });

  /** Speaks a batch into the live generation. Without one, it waits for the next briefing. */
  const deliver = (batch: ReadonlyArray<VoiceNotice>) =>
    Effect.gen(function* () {
      const initial = (yield* Ref.get(state)).live;
      if (initial === undefined || batch.length === 0) return;
      yield* awaitPause(initial, isUrgentBatch(batch) ? QUIET_BEFORE_URGENT : QUIET_BEFORE_ROUTINE);
      // A rotation while waiting hands the batch to the newer generation.
      const { live } = yield* Ref.get(state);
      if (live === undefined) return;
      // voice_pending_notices may have handed some to the agent already.
      const fresh = yield* Effect.gen(function* () {
        // Resolve queued questions against current state before delayed speech.
        for (const threadId of new Set(
          batch.filter((notice) => notice.requestId !== undefined).map((notice) => notice.threadId),
        )) {
          const records = yield* t3.threadProjection(threadId);
          const pending = new Set(
            records.runtimeRequests
              .filter((request) => request.status === "pending")
              .map((request) => request.id),
          );
          for (const notice of batch) {
            if (
              notice.threadId === threadId &&
              notice.requestId !== undefined &&
              !pending.has(notice.requestId)
            ) {
              yield* store.resolveRequestNotice(threadId, notice.requestId);
            }
          }
        }
        const undelivered = new Set(
          (yield* store.undeliveredNotices(NOTICE_LOOKBACK)).map((notice) => notice.id),
        );
        yield* publishRequestNotices;
        return batch.filter((notice) => undelivered.has(notice.id));
      }).pipe(noticeLock.withPermits(1));
      if (fresh.length === 0) return;
      yield* live.call.appendSpeech(composeNoticeBatch(fresh));
      yield* Effect.gen(function* () {
        const pendingIds = new Set(
          (yield* store.pendingRequestNotices(NOTICE_LOOKBACK)).map((notice) => notice.id),
        );
        for (const notice of fresh) {
          const attention = notice.kind === "input" || notice.kind === "approval";
          if (attention && (live.supportsRequestNotices || !pendingIds.has(notice.id))) continue;
          yield* Queue.offer(live.events, { type: "notice", notice });
        }
      }).pipe(noticeLock.withPermits(1));
      yield* store.markDelivered(fresh.map((notice) => notice.id));
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("voice-session.deliver-failed", { cause })),
    );

  // Requests that came or went while T3 was unreachable are rebuilt from scratch.
  yield* t3.resynced.pipe(
    Stream.runForEach(() =>
      reconcileRequests(true).pipe(
        Effect.andThen(publishRequestNotices),
        noticeLock.withPermits(1),
        Effect.catchCause((cause) => Effect.logWarning("voice-session.resync-failed", { cause })),
      ),
    ),
    Effect.forkScoped,
  );
  yield* t3.threadChanges.pipe(
    Stream.runForEach(handleChange),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logError("voice-session.event-feed-stopped", { cause }),
    ),
    Effect.forkScoped,
  );
  yield* Stream.fromQueue(pendingNotices).pipe(
    Stream.groupedWithin(NOTICE_BATCH_MAX, NOTICE_BATCH_WINDOW),
    Stream.runForEach(deliver),
    Effect.forkScoped,
  );

  const briefingFor = (generation: number, focusThreadId: ThreadId | undefined) =>
    Effect.gen(function* () {
      yield* reconcileRequests().pipe(noticeLock.withPermits(1));
      const [openAgenda, transcript, pending, snapshot, now] = yield* Effect.all([
        store.listAgenda({ status: "open" }),
        store.recentTranscript(60),
        store.undeliveredNotices(NOTICE_LOOKBACK),
        t3.shell,
        DateTime.now,
      ]);
      // Voice may sit unused for days while notices pile up. Brief only recent
      // news and the newest agenda; `open` marks everything pending delivered.
      const since = (hours: number) => DateTime.toEpochMillis(now) - hours * 3_600_000;
      const undelivered = pending
        .filter((notice) => DateTime.toEpochMillis(notice.createdAt) >= since(NOTICE_FRESH_HOURS))
        .slice(-BRIEFING_NOTICES);
      const agenda = openAgenda
        .filter(
          (item) =>
            item.kind === "topic" ||
            DateTime.toEpochMillis(item.openedAt) >= since(THREAD_AGENDA_FRESH_HOURS),
        )
        .slice(-BRIEFING_AGENDA_ITEMS);
      const projectTitles = new Map(
        snapshot.projects.map((project) => [project.id, project.title]),
      );
      const visible = snapshot.threads.filter(
        (thread) => thread.lineage.relationshipToParent !== "subagent",
      );
      const focus = visible.find((thread) => thread.id === focusThreadId);
      const briefing = buildBriefing({
        generation,
        agenda,
        transcript,
        undelivered,
        threads: visible.map((thread) => ({
          threadId: thread.id,
          title: thread.title,
          projectTitle: projectTitles.get(thread.projectId) ?? "",
          status: thread.status,
          updatedAt: thread.updatedAt,
        })),
        ...(focus === undefined ? {} : { focusThread: { threadId: focus.id, title: focus.title } }),
      });
      return { briefing, pending, focus, agenda };
    });

  /** Prepares the next session thread ahead of rotation, unless one is ready. */
  const prewarm = (generation: number) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(state)).warm !== undefined) return;
      const prepared = yield* sessions.prepare({ generation: generation + 1 });
      const stale = yield* Ref.modify(state, (current) =>
        current.warm === undefined
          ? [undefined, { ...current, warm: prepared }]
          : [prepared, current],
      );
      if (stale !== undefined) yield* sessions.release(stale.sessionThreadId);
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("voice-session.prewarm-failed", { cause })),
    );

  const openGeneration = (
    input: VoiceSessionOpenInput,
    startupEvents: Queue.Queue<VoiceSessionEvent>,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (input.startupProgress === true)
          yield* Queue.offer(startupEvents, { type: "startup", stage: "preparing-session" });
        const generation = yield* store.nextGeneration;
        const prepared = yield* Effect.acquireRelease(
          Ref.modify(state, (current) => [current.warm, { ...current, warm: undefined }]).pipe(
            Effect.flatMap((warm) =>
              warm === undefined ? sessions.prepare({ generation }) : Effect.succeed(warm),
            ),
          ),
          ({ sessionThreadId }) => sessions.release(sessionThreadId),
        );
        if (input.startupProgress === true)
          yield* Queue.offer(startupEvents, { type: "startup", stage: "briefing" });
        const { briefing, pending, focus, agenda } = yield* briefingFor(
          generation,
          input.focusThreadId,
        );
        const lastActivity = yield* Ref.make(0);
        const lastUserActivity = yield* Ref.make(0);
        const markActivity = (role: "user" | "assistant") =>
          DateTime.now.pipe(
            Effect.map(DateTime.toEpochMillis),
            Effect.flatMap((now) =>
              Ref.set(lastActivity, now).pipe(
                Effect.andThen(role === "user" ? Ref.set(lastUserActivity, now) : Effect.void),
              ),
            ),
          );
        if (input.startupProgress === true)
          yield* Queue.offer(startupEvents, { type: "startup", stage: "starting-realtime" });
        const call = yield* Effect.acquireRelease(
          prepared.startRealtimeCall({
            sdpOffer: input.sdpOffer,
            prompt: VOICE_SESSION_PROMPT,
            initialItems: briefing.initialItems,
            agentStartInstructions: agentBriefing(focus, agenda),
            onActivity: markActivity,
            onTranscript: ({ role, text }) =>
              markActivity(role).pipe(
                Effect.andThen(DateTime.now),
                Effect.flatMap((at) => store.appendTranscript({ generation, role, text, at })),
              ),
          }),
          (started) => started.stop.pipe(Effect.ignore),
          { interruptible: true },
        );
        const current: Generation = {
          supportsRequestNotices: input.supportsRequestNotices === true,
          generation,
          sessionThreadId: prepared.sessionThreadId,
          focusThreadId: input.focusThreadId,
          call,
          events: yield* Queue.unbounded<VoiceSessionEvent>(),
          end: yield* Deferred.make<GenerationEnd>(),
          lastActivity,
          lastUserActivity,
        };
        // Registered before `current` goes live, so it can never be left live.
        // Hanging up (not rotating) also drops a warm thread nobody will use.
        yield* Effect.addFinalizer(() =>
          Ref.get(confirmations).pipe(
            Effect.flatMap((pending) =>
              Effect.forEach([...pending.values()], (entry) =>
                entry.generation === generation
                  ? resolveConfirmation(entry.request.id, false)
                  : Effect.void,
              ),
            ),
            Effect.andThen(
              Ref.modify(state, (existing) =>
                existing.live === current
                  ? [existing.warm, { live: undefined, warm: undefined }]
                  : [undefined, existing],
              ).pipe(
                Effect.flatMap((warm) =>
                  warm === undefined ? Effect.void : sessions.release(warm.sessionThreadId),
                ),
              ),
            ),
          ),
        );
        // Generations are numbered before setup, so a slow older open that
        // finishes after a newer one yields to it instead of replacing it.
        const previous = yield* Ref.modify(state, (existing) =>
          existing.live !== undefined && existing.live.generation > generation
            ? [current, existing]
            : [existing.live, { ...existing, live: current }],
        );
        if (previous !== undefined) {
          yield* Deferred.succeed(previous.end, { reason: "rotated" });
        }
        // Publish after going live under the same lock as request events. A
        // resolution during setup cannot be overwritten by an older snapshot.
        yield* Effect.gen(function* () {
          if ((yield* Ref.get(state)).live !== current) return;
          // Retire the old call's gates before scheduling fresh gates for this generation.
          yield* Effect.forEach([...(yield* Ref.get(confirmations)).values()], (pending) =>
            pending.generation < current.generation
              ? resolveConfirmation(pending.request.id, false)
              : Effect.void,
          );
          for (const [key, attempt] of (yield* Ref.get(approvalAttempts)).entries()) {
            if (attempt.generation < current.generation) yield* clearApprovalAttempt(key);
          }
          yield* reconcileRequests(true);
          if (current.supportsRequestNotices) {
            yield* Queue.offer(current.events, {
              type: "request_notices",
              notices: yield* store.pendingRequestNotices(BRIEFING_NOTICES),
            });
          }
          yield* Effect.forEach((yield* Ref.get(confirmations)).values(), (pending) =>
            Deferred.isDone(pending.decided).pipe(
              Effect.flatMap((done) =>
                done || pending.generation !== current.generation
                  ? Effect.void
                  : Queue.offer(current.events, { type: "confirm", request: pending.request }).pipe(
                      Effect.asVoid,
                    ),
              ),
            ),
          );
        }).pipe(noticeLock.withPermits(1));
        yield* store.markDelivered(pending.map((notice) => notice.id));

        const rotateAt = Duration.toMillis(ROTATE_AFTER);
        yield* Effect.sleep(Duration.millis(rotateAt - Duration.toMillis(PREWARM_LEAD))).pipe(
          Effect.andThen(prewarm(generation)),
          Effect.andThen(Effect.sleep(PREWARM_LEAD)),
          Effect.andThen(Queue.offer(current.events, { type: "rotate" })),
          Effect.forkScoped,
        );
        yield* Effect.raceFirst(
          Deferred.await(current.end),
          call.ended.pipe(
            Effect.map((result): GenerationEnd =>
              result.type === "error"
                ? { reason: "error", message: result.message }
                : { reason: "closed" },
            ),
          ),
        ).pipe(
          Effect.flatMap((ended) =>
            Queue.offer(current.events, {
              type: "ended",
              reason: ended.reason,
              ...(ended.message === undefined ? {} : { message: ended.message }),
            }),
          ),
          Effect.forkScoped,
        );

        const answer: VoiceSessionEvent = {
          type: "answer",
          generation,
          sessionThreadId: prepared.sessionThreadId,
          sdpAnswer: call.sdpAnswer,
        };
        return Stream.make(answer).pipe(
          Stream.concat(
            Stream.fromQueue(current.events).pipe(
              Stream.takeUntil((event) => event.type === "ended"),
            ),
          ),
        );
      }),
    ).pipe(
      Stream.catchCause((cause) => {
        const failed: VoiceSessionEvent = {
          type: "ended",
          reason: "error",
          message: Option.match(Cause.findErrorOption(cause), {
            onNone: () => "The voice session failed.",
            onSome: (error) =>
              typeof error === "object" && error !== null && "message" in error
                ? String(error.message)
                : "The voice session failed.",
          }),
        };
        return Stream.make(failed);
      }),
    );

  const open: VoiceOrchestratorShape["open"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const events = yield* Effect.acquireRelease(
          Queue.unbounded<VoiceSessionEvent>(),
          Queue.shutdown,
        );
        // Setup runs while the consumer receives progress. Its resources and
        // workers share this stream's scope, including cancellation during setup.
        yield* openGeneration(input, events).pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        return Stream.fromQueue(events).pipe(Stream.takeUntil((event) => event.type === "ended"));
      }),
    );

  return VoiceOrchestrator.of({
    open,
    respond,
    requestConfirmation,
    proposeAction,
    pendingConfirmations,
    approveSpoken,
    claimSpokenSend,
    liveSession: (threadId) =>
      Ref.get(state).pipe(
        Effect.map(({ live }) =>
          live !== undefined && live.sessionThreadId === threadId
            ? Option.some({
                sessionThreadId: live.sessionThreadId,
                generation: live.generation,
                focusThreadId: live.focusThreadId,
              })
            : Option.none(),
        ),
      ),
  });
});

export const layer = Layer.effect(VoiceOrchestrator, make);
