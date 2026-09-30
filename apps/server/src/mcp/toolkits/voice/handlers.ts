import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  OrchestratorMcpFailure,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type VoiceMcpThreadSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ThreadLaunchService } from "../../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { isSpokenConfirmation } from "../../../orchestration-v2/voice/VoiceConfirmation.ts";
import { VoiceOrchestrator } from "../../../orchestration-v2/voice/VoiceOrchestrator.ts";
import { VoiceStore } from "../../../orchestration-v2/voice/VoiceStore.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { newCommandId } from "../../threadAccess.ts";
import { VoiceToolkit } from "./tools.ts";

const DEFAULT_THREADS_LIMIT = 30;
const DEFAULT_READ_LIMIT = 10;
const MAX_MESSAGE_CHARS = 1_500;
/** How far back the spoken yes for a send may be. */
const CONFIRMATION_TRANSCRIPT_ENTRIES = 40;

/** A spoken yes older than this no longer approves a send. */
const CONFIRMATION_MAX_AGE_MS = 2 * 60_000;

const NEEDS_SPOKEN_YES =
  "Nothing was sent. Read the message back to the user word for word, naming the thread it goes to, wait for them to say yes, then call voice_send again with exactly that text.";

const orchestrationError = (message: string) => () =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

const threadNotFound = () =>
  new OrchestratorMcpFailure({ code: "thread_not_found", message: "The thread was not found." });

/** Status the way the sidebar shows it: an active run's phase wins over the settled status. */
function summaryOf(
  thread: OrchestrationV2ThreadShell,
  projectTitles: ReadonlyMap<string, string>,
): VoiceMcpThreadSummary {
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    projectTitle: projectTitles.get(thread.projectId) ?? "Unknown project",
    title: thread.title,
    status: thread.activityRunStatus ?? thread.status,
    needsInput: thread.pendingRuntimeRequest !== null,
    updatedAt: DateTime.formatIso(thread.updatedAt),
  };
}

const make = Effect.gen(function* () {
  const voice = yield* VoiceOrchestrator;
  const store = yield* VoiceStore;
  const threads = yield* ThreadManagementService;
  const launches = yield* ThreadLaunchService;
  const projects = yield* ProjectService;
  /** The user replies that already approved a send, so one yes can't approve two. */
  const usedYes = yield* Ref.make<ReadonlySet<string>>(new Set());

  /** Refuses every caller except a live voice session thread. */
  const requireVoiceSession = Effect.gen(function* () {
    const scope = yield* McpInvocationContext;
    const session = yield* voice.liveSession(scope.threadId);
    if (Option.isNone(session))
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Voice tools only work in a live voice session.",
      });
    return session.value;
  });

  const projectTitles = projects.snapshot.pipe(
    Effect.map(
      (snapshot) =>
        new Map(snapshot.projects.map((project) => [project.id as string, project.title])),
    ),
    Effect.mapError(orchestrationError("Could not read projects.")),
  );

  const requireThread = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(orchestrationError(`Could not read thread ${threadId}.`)),
      Effect.flatMap((thread) =>
        thread === null || thread.deletedAt !== null
          ? Effect.fail(threadNotFound())
          : Effect.succeed(thread),
      ),
    );

  return VoiceToolkit.of({
    voice_threads: (input) =>
      Effect.gen(function* () {
        const session = yield* requireVoiceSession;
        const sessionThread = yield* requireThread(session.sessionThreadId);
        const snapshot = yield* threads
          .getShellSnapshot()
          .pipe(Effect.mapError(orchestrationError("Could not list threads.")));
        const titles = yield* projectTitles;
        return {
          threads: snapshot.threads
            .filter(
              (thread) =>
                thread.archivedAt === null &&
                thread.deletedAt === null &&
                thread.lineage.relationshipToParent !== "subagent" &&
                // The voice project only holds session threads.
                thread.projectId !== sessionThread.projectId,
            )
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
            )
            .slice(0, input.limit ?? DEFAULT_THREADS_LIMIT)
            .map((thread) => summaryOf(thread, titles)),
        };
      }),

    voice_thread_read: (input) =>
      Effect.gen(function* () {
        yield* requireVoiceSession;
        const thread = yield* requireThread(input.threadId);
        const records = yield* threads
          .getThreadRecords(input.threadId, ["messages"], {
            messageRoles: ["user", "assistant"],
          })
          .pipe(Effect.mapError(orchestrationError(`Could not read thread ${input.threadId}.`)));
        const titles = yield* projectTitles;
        return {
          thread: summaryOf(thread, titles),
          messages: records.messages
            .flatMap(({ role, text, createdAt }) =>
              role === "system"
                ? []
                : [
                    {
                      role,
                      text: text.slice(0, MAX_MESSAGE_CHARS),
                      truncated: text.length > MAX_MESSAGE_CHARS,
                      createdAt: DateTime.formatIso(createdAt),
                    },
                  ],
            )
            .slice(-(input.limit ?? DEFAULT_READ_LIMIT)),
        };
      }),

    voice_pending_notices: () =>
      Effect.gen(function* () {
        yield* requireVoiceSession;
        const notices = yield* store.undeliveredNotices(20);
        yield* store.markDelivered(notices.map((notice) => notice.id));
        return { notices };
      }),

    voice_agenda_list: () =>
      Effect.gen(function* () {
        yield* requireVoiceSession;
        return { items: yield* store.listAgenda({ status: "open" }) };
      }),

    voice_topic_open: (input) =>
      Effect.gen(function* () {
        yield* requireVoiceSession;
        return { item: yield* store.openTopic(input) };
      }),

    voice_topic_close: (input) =>
      Effect.gen(function* () {
        yield* requireVoiceSession;
        return { closed: yield* store.closeItem(input.id) };
      }),

    // The gate is the user's own words: the draft must match something they
    // said yes to in the call transcript. The session thread's read-only mode
    // does not apply to the target, which sits in another project.
    voice_send: (input) =>
      Effect.gen(function* () {
        const session = yield* requireVoiceSession;
        const target = yield* requireThread(input.threadId);
        // Only this call's words count, and only a recent yes. A new call is a
        // new generation, so nothing said before a restart can approve a send.
        const transcript = (yield* store.recentTranscript(CONFIRMATION_TRANSCRIPT_ENTRIES)).filter(
          (entry) => entry.generation === session.generation,
        );
        const reply = transcript.findLast((entry) => entry.role === "user");
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        if (
          reply === undefined ||
          now - DateTime.toEpochMillis(reply.at) > CONFIRMATION_MAX_AGE_MS ||
          !isSpokenConfirmation(transcript, input.text, target.title)
        )
          return { status: "needs_spoken_yes" as const, instruction: NEEDS_SPOKEN_YES };
        // Check and claim in one step, so parallel calls can't share a yes.
        const replyKey = `${reply.generation}:${DateTime.toEpochMillis(reply.at)}`;
        const claimed = yield* Ref.modify(usedYes, (used) =>
          used.has(replyKey) ? [false, used] : [true, new Set(used).add(replyKey)],
        );
        if (!claimed) return { status: "needs_spoken_yes" as const, instruction: NEEDS_SPOKEN_YES };
        const commandId = yield* newCommandId();
        const result = yield* threads
          .sendToThread({
            projectId: target.projectId,
            commandId,
            threadId: target.id,
            senderThreadId: session.sessionThreadId,
            messageId: MessageId.make(commandId),
            text: input.text,
            attachments: [],
            mode: input.mode ?? "auto",
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(orchestrationError(`Could not send to thread ${target.id}.`)));
        return {
          status: "sent" as const,
          threadId: target.id,
          runId: result.run.id,
          delivery: result.delivery,
        };
      }),

    voice_launch: (input) =>
      Effect.gen(function* () {
        const session = yield* requireVoiceSession;
        const project = yield* projects.getById(input.projectId).pipe(
          Effect.mapError(orchestrationError("Could not read the project.")),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: "The project was not found.",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        const approved = yield* voice.requestConfirmation({
          action: "launch",
          title: `Start "${input.title}" in ${project.title}?`,
          detail: input.message,
        });
        if (!approved) return { status: "denied" as const };
        const sessionThread = yield* requireThread(session.sessionThreadId);
        const commandId = yield* newCommandId();
        const messageId = MessageId.make(commandId);
        const result = yield* launches
          .launch({
            commandId,
            threadId: ThreadId.make(commandId),
            projectId: project.id,
            title: input.title,
            modelSelection: project.defaultModelSelection ?? sessionThread.modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId,
              senderThreadId: session.sessionThreadId,
              text: input.message,
              attachments: [],
            },
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(orchestrationError("Could not start the thread.")));
        const run = result.projection.runs.find(
          (candidate) => candidate.userMessageId === messageId,
        );
        return { status: "launched" as const, threadId: result.threadId, runId: run?.id ?? null };
      }),

    voice_interrupt: (input) =>
      Effect.gen(function* () {
        yield* requireVoiceSession;
        const target = yield* requireThread(input.threadId);
        const approved = yield* voice.requestConfirmation({
          action: "interrupt",
          threadId: target.id,
          title: `Stop "${target.title}"?`,
          detail: "Stops the thread's running turn.",
        });
        if (!approved) return { threadId: target.id, status: "denied" as const };
        const result = yield* threads
          .interruptThread({
            projectId: target.projectId,
            commandId: yield* newCommandId(),
            threadId: target.id,
            reason: "Stopped from the voice session.",
          })
          .pipe(Effect.mapError(orchestrationError(`Could not stop thread ${target.id}.`)));
        return { threadId: target.id, status: result.type };
      }),
  });
});

export const VoiceToolkitHandlersLive = VoiceToolkit.toLayer(make);
