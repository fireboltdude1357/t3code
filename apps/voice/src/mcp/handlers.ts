import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type ProviderInstanceId,
  ThreadId,
  type VoiceMcpThreadSummary,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { T3Client } from "../T3Client.ts";
import { confirmationReadback, sendReadback } from "../VoiceConfirmation.ts";
import { VoiceOrchestrator } from "../VoiceOrchestrator.ts";
import { VoiceStore } from "../VoiceStore.ts";
import { VoiceToolkit } from "./tools.ts";
import { VoiceMcpCaller } from "./VoiceMcpCaller.ts";

const DEFAULT_THREADS_LIMIT = 30;
const DEFAULT_READ_LIMIT = 10;
const MAX_MESSAGE_CHARS = 1_500;
const NEEDS_SPOKEN_YES =
  "Nothing was sent. Return only the readback, unchanged, for the voice model to speak verbatim. Wait for the user's complete reply and a fresh yes, then call voice_send again with the same threadId and text.";

/** Threads the voice orchestrator starts run Opus 5.5 on high with full access. */
const LAUNCH_MODEL = "claude-opus-5-5";
const LAUNCH_DRIVER = "claudeAgent";

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

const titlesOf = (projects: ReadonlyArray<OrchestrationProjectShell>) =>
  new Map(projects.map((project) => [project.id as string, project.title]));

const make = Effect.gen(function* () {
  const voice = yield* VoiceOrchestrator;
  const store = yield* VoiceStore;
  const t3 = yield* T3Client;
  const crypto = yield* Crypto.Crypto;

  const commandId = crypto.randomUUIDv4.pipe(
    Effect.orDie,
    Effect.map((id) => CommandId.make(`voice-sidecar:${id}`)),
  );

  /** Refuses every caller except the live generation's session thread. */
  const requireVoiceSession = Effect.gen(function* () {
    const caller = yield* VoiceMcpCaller;
    const session = yield* voice.liveSession(caller.sessionThreadId);
    if (Option.isNone(session))
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Voice tools only work in a live voice session.",
      });
    return session.value;
  });

  /**
   * Picks a usable Claude instance that offers the launch model, preferring
   * the project's own instance so the thread runs on the account it uses.
   * Fails instead of falling back, so a launch never runs on a model nobody chose.
   */
  const launchModelSelection = (preferred: ProviderInstanceId | undefined) =>
    t3.providers.pipe(
      Effect.mapError(orchestrationError("Could not read the T3 providers.")),
      Effect.flatMap((snapshots) => {
        const usable = snapshots.filter(
          (provider) =>
            provider.driver === LAUNCH_DRIVER &&
            provider.enabled &&
            provider.installed &&
            isProviderAvailable(provider) &&
            provider.status !== "error" &&
            provider.status !== "disabled" &&
            provider.auth.status !== "unauthenticated" &&
            provider.models.some((model) => model.slug === LAUNCH_MODEL),
        );
        const instance = usable.find((provider) => provider.instanceId === preferred) ?? usable[0];
        return instance === undefined
          ? Effect.fail(
              new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "No working Claude provider offers Opus 5.5, so nothing was started.",
              }),
            )
          : Effect.succeed<ModelSelection>({
              instanceId: instance.instanceId,
              model: LAUNCH_MODEL,
              options: [{ id: "effort", value: "high" }],
            });
      }),
    );

  const requireThread = (threadId: ThreadId) =>
    t3
      .threadShell(threadId)
      .pipe(
        Effect.flatMap((thread) =>
          thread === null || thread.deletedAt !== null
            ? Effect.fail(threadNotFound())
            : Effect.succeed(thread),
        ),
      );

  const projection = (threadId: ThreadId, failure: string) =>
    t3.threadProjection(threadId).pipe(Effect.mapError(orchestrationError(failure)));

  return VoiceToolkit.of({
    voice_projects: () =>
      Effect.gen(function* () {
        yield* requireVoiceSession;
        const { projects } = yield* t3.shell;
        return {
          projects: projects.map((project) => ({
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          })),
        };
      }),

    voice_threads: (input) =>
      Effect.gen(function* () {
        yield* requireVoiceSession;
        const { projects, threads } = yield* t3.shell;
        const titles = titlesOf(projects);
        return {
          threads: threads
            .filter(
              (thread) =>
                thread.archivedAt === null &&
                thread.deletedAt === null &&
                thread.lineage.relationshipToParent !== "subagent",
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
        const records = yield* projection(
          input.threadId,
          `Could not read thread ${input.threadId}.`,
        );
        const { projects } = yield* t3.shell;
        return {
          thread: summaryOf(thread, titlesOf(projects)),
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

    voice_pending_question_list: (input) =>
      Effect.gen(function* () {
        yield* requireVoiceSession;
        yield* requireThread(input.threadId);
        const records = yield* projection(input.threadId, "Could not read pending questions.");
        return {
          threadId: input.threadId,
          requestIds: records.runtimeRequests
            .filter((request) => request.kind === "user_input" && request.status === "pending")
            .map((request) => request.id),
        };
      }),

    voice_pending_question_read: (input) =>
      Effect.gen(function* () {
        yield* requireVoiceSession;
        yield* requireThread(input.threadId);
        const records = yield* projection(input.threadId, "Could not read the pending question.");
        const request = records.runtimeRequests.find(
          (request) =>
            request.id === input.requestId &&
            request.kind === "user_input" &&
            request.status === "pending",
        );
        const item = records.turnItems.find(
          (item) => item.type === "user_input_request" && item.requestId === input.requestId,
        );
        if (request === undefined || item?.type !== "user_input_request")
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The pending user-input request was not found.",
          });
        return {
          threadId: input.threadId,
          requestId: input.requestId,
          questions: item.questions,
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

    // The gate is the user's own words: they must have said yes to the exact
    // code-owned readback of this draft and thread in the call transcript.
    voice_send: (input) =>
      Effect.gen(function* () {
        const session = yield* requireVoiceSession;
        const target = yield* requireThread(input.threadId);
        if (
          !(yield* voice.claimSpokenSend({
            sessionThreadId: session.sessionThreadId,
            text: input.text,
            targetTitle: target.title,
          }))
        )
          return {
            status: "needs_spoken_yes" as const,
            instruction: NEEDS_SPOKEN_YES,
            readback: sendReadback(target.title, input.text),
          };
        yield* requireVoiceSession;
        const id = yield* commandId;
        const queued = input.mode === "queue";
        yield* t3
          .dispatch({
            type: "message.dispatch",
            commandId: id,
            threadId: target.id,
            messageId: MessageId.make(id),
            text: input.text,
            attachments: [],
            createdBy: "agent",
            creationSource: "mcp",
            ...(queued
              ? { dispatchMode: { type: "queue_after_active" as const } }
              : {
                  dispatchMode: { type: "start_immediately" as const },
                  deliveryIntent: "auto" as const,
                }),
          })
          .pipe(Effect.mapError(orchestrationError(`Could not send to thread ${target.id}.`)));
        return {
          status: "sent" as const,
          threadId: target.id,
          delivery: queued ? ("queued" as const) : ("auto" as const),
        };
      }),

    voice_confirmations: () =>
      Effect.gen(function* () {
        const session = yield* requireVoiceSession;
        const requests = yield* voice.pendingConfirmations(session.sessionThreadId);
        return {
          requests: requests.map((request) => ({
            request: { ...request, expiresAt: DateTime.formatIso(request.expiresAt) },
            readback: confirmationReadback(request),
          })),
        };
      }),

    voice_approve: (input) =>
      Effect.gen(function* () {
        const session = yield* requireVoiceSession;
        return yield* voice.approveSpoken({
          sessionThreadId: session.sessionThreadId,
          requestId: input.requestId,
        });
      }),

    voice_launch: (input) =>
      Effect.gen(function* () {
        const session = yield* requireVoiceSession;
        const { projects } = yield* t3.shell;
        const project = projects.find((candidate) => candidate.id === input.projectId);
        if (project === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The project was not found.",
          });
        const modelSelection = yield* launchModelSelection(
          project.defaultModelSelection?.instanceId,
        );
        const id = yield* commandId;
        const request = yield* voice.proposeAction({
          sessionThreadId: session.sessionThreadId,
          action: "launch",
          title: `Start "${input.title}" in ${project.title}?`,
          detail: input.message,
          execute: t3
            .launchThread({
              commandId: id,
              creationSource: "mcp",
              threadId: ThreadId.make(id),
              projectId: project.id,
              title: input.title,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              workspaceStrategy: { type: "root" },
              initialMessage: {
                messageId: MessageId.make(id),
                text: input.message,
                attachments: [],
              },
            })
            .pipe(Effect.as(`Started "${input.title}" in ${project.title}.`), Effect.orDie),
        });
        return Option.isNone(request)
          ? { status: "denied" as const }
          : {
              status: "needs_approval" as const,
              request: { ...request.value, expiresAt: DateTime.formatIso(request.value.expiresAt) },
              readback: confirmationReadback(request.value),
            };
      }),

    voice_interrupt: (input) =>
      Effect.gen(function* () {
        const session = yield* requireVoiceSession;
        const target = yield* requireThread(input.threadId);
        const runId = target.activeRunId;
        if (runId === null) return { threadId: target.id, status: "no_active_run" as const };
        const id = yield* commandId;
        const request = yield* voice.proposeAction({
          sessionThreadId: session.sessionThreadId,
          action: "interrupt",
          threadId: target.id,
          title: `Stop "${target.title}"?`,
          detail: "Stops the thread's current running turn.",
          execute: Effect.gen(function* () {
            const current = yield* t3.threadShell(target.id);
            if (current?.activeRunId !== runId)
              return yield* Effect.die("The thread's running turn changed.");
            yield* t3.dispatch({
              type: "run.interrupt",
              commandId: id,
              threadId: target.id,
              runId,
              reason: "Stopped from the voice session.",
            });
            return `Requested interruption of "${target.title}".`;
          }).pipe(Effect.orDie),
        });
        return Option.isNone(request)
          ? { threadId: target.id, status: "denied" as const }
          : {
              status: "needs_approval" as const,
              threadId: target.id,
              request: { ...request.value, expiresAt: DateTime.formatIso(request.value.expiresAt) },
              readback: confirmationReadback(request.value),
            };
      }),
  });
});

export const VoiceToolkitHandlersLive = VoiceToolkit.toLayer(make);
