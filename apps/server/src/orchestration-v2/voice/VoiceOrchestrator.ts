import {
  CommandId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  type ProviderApprovalDecision,
  type ThreadId,
  type VoiceAgendaItem,
  type VoiceConfirmAction,
  type VoiceConfirmRequest,
  type VoiceNotice,
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import type { ProviderAdapterV2RealtimeCall } from "../ProviderAdapter.ts";
import { RuntimeRequestServiceV2 } from "../RuntimeRequestService.ts";
import { ThreadManagementService } from "../ThreadManagementService.ts";
import { buildBriefing } from "./VoiceBriefing.ts";
import { composeNoticeBatch, isUrgentBatch, noticeForEvent } from "./VoiceNotificationPolicy.ts";
import { VoiceSessionRegistry } from "./VoiceSessionRegistry.ts";
import { type PreparedSessionThread, VoiceSessionService } from "./VoiceSessionService.ts";
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
  "t3/orchestration-v2/voice/VoiceOrchestrator",
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
const VOICE_PROJECT_TITLE = "Voice";

/** Instructions for the realtime voice model. */
export const VOICE_SESSION_PROMPT = [
  "You are Tanner's voice orchestrator for all of his T3 Code threads. He may talk to you for hours while driving or walking. Be brief and conversational.",
  "Hand lookups, questions about threads, and any action to the background agent. It can see every thread; you cannot.",
  'Lines that start with "Update from T3:" are news about other threads, timed by the system for a pause. Say them briefly and let the user decide whether to dig in.',
  "When a tangent wraps up, come back to open agenda items from your briefing or the agent.",
  "To send or queue a message to a thread: get a draft, read it back word for word, and ask whether to send it. Only after a clear yes, hand off so the agent can send. If anything changes, read the new draft back and ask again.",
  "Launching a thread, interrupting one, and approvals need a tap on the phone. Say so, and wait.",
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
  readonly call: ProviderAdapterV2RealtimeCall;
  readonly events: Queue.Queue<VoiceSessionEvent>;
  readonly end: Deferred.Deferred<GenerationEnd>;
  /** Epoch millis of the last transcript delta from either side. */
  readonly lastActivity: Ref.Ref<number>;
}

interface State {
  readonly live: Generation | undefined;
  /** A session thread prepared ahead of rotation, taken by the next open. */
  readonly warm: PreparedSessionThread | undefined;
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectService;
  const runtimeRequests = yield* RuntimeRequestServiceV2;
  const sessions = yield* VoiceSessionService;
  const registry = yield* VoiceSessionRegistry;
  const store = yield* VoiceStore;
  const config = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const state = yield* Ref.make<State>({ live: undefined, warm: undefined });
  const confirmations = yield* Ref.make(
    new Map<
      string,
      { readonly request: VoiceConfirmRequest; readonly decided: Deferred.Deferred<boolean> }
    >(),
  );
  const voiceProjectId = yield* Ref.make<ProjectId | undefined>(undefined);

  /** The dedicated Voice project, created on first use. */
  const voiceProject = Effect.gen(function* () {
    const cached = yield* Ref.get(voiceProjectId);
    if (cached !== undefined) return cached;
    const workspaceRoot = path.join(config.stateDir, "voice");
    // Bootstrap looks the project up by an existing root before creating it.
    yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true });
    const { project } = yield* projects.bootstrap({
      commandId: CommandId.make(`server:voice-session:project:${yield* uuid}`),
      projectId: ProjectId.make(yield* uuid),
      title: VOICE_PROJECT_TITLE,
      workspaceRoot,
    });
    yield* Ref.set(voiceProjectId, project.id);
    return project.id;
  });

  const offerToLive = (event: VoiceSessionEvent) =>
    Ref.get(state).pipe(
      Effect.flatMap(({ live }) =>
        live === undefined ? Effect.void : Queue.offer(live.events, event).pipe(Effect.asVoid),
      ),
    );

  const requestConfirmation: VoiceOrchestratorShape["requestConfirmation"] = (input) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(state)).live === undefined) return false;
      const id = `voice-confirm:${yield* uuid}`;
      const decided = yield* Deferred.make<boolean>();
      const request: VoiceConfirmRequest = {
        id,
        action: input.action,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        title: input.title,
        detail: input.detail,
        expiresAt: DateTime.add(yield* DateTime.now, { minutes: 2 }),
      };
      yield* Ref.update(confirmations, (current) => new Map(current).set(id, { request, decided }));
      yield* offerToLive({ type: "confirm", request });
      const approved = yield* Deferred.await(decided).pipe(
        Effect.timeoutOption(CONFIRM_TIMEOUT),
        Effect.map(Option.getOrElse(() => false)),
        Effect.ensuring(
          Ref.update(confirmations, (current) => {
            const updated = new Map(current);
            updated.delete(id);
            return updated;
          }),
        ),
      );
      yield* offerToLive({ type: "confirm_resolved", requestId: id, approved });
      return approved;
    });

  const respond: VoiceOrchestratorShape["respond"] = ({ requestId, approved }) =>
    Ref.get(confirmations).pipe(
      Effect.flatMap((current) => {
        const pending = current.get(requestId);
        return pending === undefined
          ? Effect.succeed({ accepted: false })
          : Deferred.succeed(pending.decided, approved).pipe(
              Effect.map((accepted) => ({ accepted })),
            );
      }),
    );

  /** Session threads, subagents and archived threads are never announced. */
  const threadInfo = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      const voiceProject = yield* Ref.get(voiceProjectId);
      return {
        threadId,
        title: shell?.title ?? "A thread",
        ignored:
          shell === null ||
          (yield* registry.has(threadId)) ||
          shell.projectId === voiceProject ||
          shell.lineage.relationshipToParent === "subagent",
      };
    });

  /** On-screen yes for another thread's approval request, answered in place. */
  const confirmRuntimeApproval = (
    event: Extract<OrchestrationV2DomainEvent, { type: "runtime-request.updated" }>,
    threadTitle: string,
  ) =>
    Effect.gen(function* () {
      const request = event.payload;
      if (request.responseCapability.type !== "live" || request.kind === "user_input") return;
      const providerSessionId = request.responseCapability.providerSessionId;
      const approved = yield* requestConfirmation({
        action: "runtime_approval",
        threadId: event.threadId,
        title: `${threadTitle} needs an approval`,
        detail: `Request: ${request.kind}. Approve once, or deny.`,
      });
      const decision: ProviderApprovalDecision = approved ? "accept" : "decline";
      if (!approved) return; // Leave a timed-out or denied request for the user in the thread.
      yield* runtimeRequests.respond({
        threadId: event.threadId,
        providerSessionId,
        requestId: request.id,
        decision,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("voice-session.approval-failed", { threadId: event.threadId, cause }),
      ),
    );

  const pendingNotices = yield* Queue.unbounded<VoiceNotice>();

  /** Turns one domain event into at most one recorded notice. */
  const handleEvent = (event: OrchestrationV2DomainEvent) =>
    Effect.gen(function* () {
      if (event.type !== "run.updated" && event.type !== "runtime-request.updated") return;
      const info = yield* threadInfo(event.threadId);
      const draft = noticeForEvent(event, info);
      if (draft === undefined) return;
      const notice: VoiceNotice = {
        id: `voice-notice:${yield* uuid}`,
        kind: draft.kind,
        threadId: draft.threadId,
        threadTitle: draft.threadTitle,
        text: draft.text,
        createdAt: yield* DateTime.now,
      };
      if (!(yield* store.recordNotice({ ...notice, dedupeKey: draft.dedupeKey }))) return;
      if (draft.agenda === "open") {
        yield* store.openThreadItem({
          threadId: draft.threadId,
          title: draft.threadTitle,
          detail: draft.text,
        });
      } else if (draft.agenda === "close") {
        yield* store.closeThreadItem(draft.threadId);
      }
      yield* Queue.offer(pendingNotices, notice);
      if (event.type === "runtime-request.updated" && (yield* Ref.get(state)).live !== undefined) {
        yield* Effect.forkDetach(confirmRuntimeApproval(event, info.title));
      }
    }).pipe(
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
      yield* live.call.appendSpeech(composeNoticeBatch(batch));
      yield* Effect.forEach(batch, (notice) =>
        Queue.offer(live.events, { type: "notice", notice }),
      );
      yield* store.markDelivered(batch.map((notice) => notice.id));
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("voice-session.deliver-failed", { cause })),
    );

  yield* threads.streamDomainEvents.pipe(
    Stream.runForEach(handleEvent),
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
      const [agenda, transcript, undelivered, snapshot, projectShells, voiceProject] =
        yield* Effect.all([
          store.listAgenda({ status: "open" }),
          store.recentTranscript(60),
          store.undeliveredNotices(20),
          threads.getShellSnapshot(),
          projects.listShells(),
          Ref.get(voiceProjectId),
        ]);
      const projectTitles = new Map(projectShells.map((project) => [project.id, project.title]));
      const visible = snapshot.threads.filter(
        (thread) =>
          thread.projectId !== voiceProject && thread.lineage.relationshipToParent !== "subagent",
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
      return { briefing, undelivered, focus, agenda };
    });

  /** Prepares the next session thread ahead of rotation, unless one is ready. */
  const prewarm = (projectId: ProjectId, generation: number) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(state)).warm !== undefined) return;
      const prepared = yield* sessions.prepare({ projectId, generation: generation + 1 });
      const stale = yield* Ref.modify(state, (current) =>
        current.warm === undefined
          ? [undefined, { ...current, warm: prepared }]
          : [prepared, current],
      );
      if (stale !== undefined) yield* sessions.release(stale.sessionThreadId);
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("voice-session.prewarm-failed", { cause })),
    );

  const open: VoiceOrchestratorShape["open"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const projectId = yield* voiceProject;
        const generation = yield* store.nextGeneration;
        const prepared = yield* Effect.acquireRelease(
          Ref.modify(state, (current) => [current.warm, { ...current, warm: undefined }]).pipe(
            Effect.flatMap((warm) =>
              warm === undefined
                ? sessions.prepare({ projectId, generation })
                : Effect.succeed(warm),
            ),
          ),
          ({ sessionThreadId }) => sessions.release(sessionThreadId),
        );
        const { briefing, undelivered, focus, agenda } = yield* briefingFor(
          generation,
          input.focusThreadId,
        );
        const lastActivity = yield* Ref.make(0);
        const markActivity = DateTime.now.pipe(
          Effect.flatMap((now) => Ref.set(lastActivity, DateTime.toEpochMillis(now))),
        );
        const call = yield* Effect.acquireRelease(
          prepared.startRealtimeCall({
            providerThread: prepared.providerThread,
            sdpOffer: input.sdpOffer,
            prompt: VOICE_SESSION_PROMPT,
            initialItems: briefing.initialItems,
            agentStartInstructions: agentBriefing(focus, agenda),
            onActivity: markActivity,
            onTranscript: ({ role, text }) =>
              DateTime.now.pipe(
                Effect.flatMap((at) => store.appendTranscript({ generation, role, text, at })),
                Effect.andThen(markActivity),
              ),
          }),
          (started) => started.stop.pipe(Effect.ignore),
        );
        const current: Generation = {
          generation,
          sessionThreadId: prepared.sessionThreadId,
          focusThreadId: input.focusThreadId,
          call,
          events: yield* Queue.unbounded<VoiceSessionEvent>(),
          end: yield* Deferred.make<GenerationEnd>(),
          lastActivity,
        };
        const previous = yield* Ref.modify(state, (existing) => [
          existing.live,
          { ...existing, live: current },
        ]);
        if (previous !== undefined) {
          yield* Deferred.succeed(previous.end, { reason: "rotated" });
        }
        yield* store.markDelivered(undelivered.map((notice) => notice.id));
        // Cards still waiting for a tap carry over to the new generation.
        yield* Effect.forEach((yield* Ref.get(confirmations)).values(), ({ request }) =>
          Queue.offer(current.events, { type: "confirm", request }),
        );
        // Hanging up (not rotating) also drops a warm thread nobody will use.
        yield* Effect.addFinalizer(() =>
          Ref.modify(state, (existing) =>
            existing.live === current
              ? [existing.warm, { live: undefined, warm: undefined }]
              : [undefined, existing],
          ).pipe(
            Effect.flatMap((warm) =>
              warm === undefined ? Effect.void : sessions.release(warm.sessionThreadId),
            ),
          ),
        );

        const rotateAt = Duration.toMillis(ROTATE_AFTER);
        yield* Effect.sleep(Duration.millis(rotateAt - Duration.toMillis(PREWARM_LEAD))).pipe(
          Effect.andThen(prewarm(projectId, generation)),
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

  return VoiceOrchestrator.of({
    open,
    respond,
    requestConfirmation,
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
