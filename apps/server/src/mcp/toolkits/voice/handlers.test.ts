import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type Project,
  type VoiceNotice,
  type VoiceAgendaItem,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ThreadLaunchService } from "../../../orchestration-v2/ThreadLaunchService.ts";
import { ProviderSessionManagerV2 } from "../../../orchestration-v2/ProviderSessionManager.ts";
import type { ProviderAdapterV2SessionRuntime } from "../../../orchestration-v2/ProviderAdapter.ts";
import {
  ThreadManagementService,
  type ThreadManagementSendInput,
  type ThreadManagementSendResult,
} from "../../../orchestration-v2/ThreadManagementService.ts";
import { VoiceOrchestrator } from "../../../orchestration-v2/voice/VoiceOrchestrator.ts";
import {
  VoiceStore,
  type VoiceTranscriptEntry,
} from "../../../orchestration-v2/voice/VoiceStore.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import type { ProjectionRecords } from "../../../orchestration-v2/ProjectionStore.ts";
import { VoiceToolkitHandlersLive } from "./handlers.ts";
import { VoiceToolkit } from "./tools.ts";

const SESSION_THREAD = ThreadId.make("voice-session");
const OTHER_THREAD = ThreadId.make("ordinary-thread");
const TARGET_THREAD = ThreadId.make("target-thread");
const WORK_PROJECT = ProjectId.make("work-project");
const DRAFT = "Please rebase onto main and rerun the tests.";
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

// Only the fields the handlers read; the rest of the shell is irrelevant here.
const shell = (id: ThreadId, projectId: ProjectId) =>
  ({
    id,
    projectId,
    title: "Target",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    providerInstanceId: ProviderInstanceId.make("codex"),
    archivedAt: null,
    activeRunId: null,
    activeProviderThreadId: ProviderThreadId.make("voice-provider-thread"),
    deletedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

const said = (role: VoiceTranscriptEntry["role"], text: string): VoiceTranscriptEntry => ({
  generation: 1,
  role,
  text,
  at: DateTime.makeUnsafe("2026-09-30T12:00:00Z"),
});

const request = (
  id: string,
  kind: OrchestrationV2RuntimeRequest["kind"] = "user_input",
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(id),
  nodeId: NodeId.make("target-node"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind,
  status,
  responseCapability: { type: "message" },
  createdAt: DateTime.makeUnsafe("2026-09-30T12:00:00Z"),
  resolvedAt: null,
});

const question = (id: string): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(`item-${id}`),
  threadId: TARGET_THREAD,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "pending",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-09-30T12:00:00Z"),
  type: "user_input_request",
  requestId: RuntimeRequestId.make(id),
  questions: [
    {
      id: "approach",
      header: "Approach",
      question: "Which approach should I use?",
      options: [{ label: "Minimal", description: "Keep the existing behavior.", value: "minimal" }],
      allowCustomAnswer: true,
    },
  ],
});

interface HarnessOptions {
  readonly transcript?: ReadonlyArray<VoiceTranscriptEntry>;
  readonly approve?: boolean;
  readonly live?: boolean;
  readonly caller?: Partial<OrchestrationV2ThreadShell>;
  readonly missingTarget?: boolean;
  readonly requests?: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly items?: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly notices?: ReadonlyArray<VoiceNotice>;
  readonly agenda?: ReadonlyArray<VoiceAgendaItem>;
  readonly binding?: "detached" | "stopped" | "error" | "missing_thread";
  readonly runtimeLive?: boolean;
}

const makeHarness = Effect.fn("makeVoiceToolkitHarness")(function* (options: HarnessOptions = {}) {
  const sends: Array<ThreadManagementSendInput> = [];
  let launches = 0;
  let confirmations = 0;
  let recordReads = 0;
  const delivered: string[] = [];
  const dependencies = Layer.mergeAll(
    Layer.succeed(Crypto.Crypto, testCrypto),
    Layer.mock(ProviderSessionManagerV2)({
      get: () =>
        Effect.succeed(
          options.runtimeLive === false
            ? Option.none()
            : Option.some({
                instanceId: ProviderInstanceId.make("codex"),
              } as ProviderAdapterV2SessionRuntime),
        ),
    }),
    Layer.mock(VoiceOrchestrator)({
      liveSession: (threadId) =>
        Effect.succeed(
          threadId === SESSION_THREAD && options.live !== false
            ? Option.some({
                sessionThreadId: SESSION_THREAD,
                generation: 1,
                focusThreadId: undefined,
              })
            : Option.none(),
        ),
      requestConfirmation: () =>
        Effect.sync(() => {
          confirmations += 1;
          return options.approve ?? false;
        }),
    }),
    Layer.mock(VoiceStore)({
      recentTranscript: () => Effect.succeed(options.transcript ?? []),
      listAgenda: () => Effect.succeed(options.agenda ?? []),
      undeliveredNotices: () => Effect.succeed(options.notices ?? []),
      markDelivered: (ids) =>
        Effect.sync(() => {
          delivered.push(...ids);
        }),
      openTopic: () => Effect.succeed(options.agenda![0]!),
    }),
    Layer.mock(ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          id === TARGET_THREAD
            ? options.missingTarget
              ? null
              : shell(TARGET_THREAD, WORK_PROJECT)
            : { ...shell(id, ProjectId.make("voice-project")), ...options.caller },
        ),
      getThreadRecords: (id, fields) =>
        Effect.sync(() => {
          if (id === TARGET_THREAD) recordReads += 1;
          const providerThread = {
            id: ProviderThreadId.make("voice-provider-thread"),
            appThreadId: SESSION_THREAD,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId: ProviderSessionId.make("runtime-session"),
          } as OrchestrationV2ProviderThread;
          const binding = {
            id: ProviderSessionId.make("runtime-session"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            status:
              options.binding === "stopped" || options.binding === "error"
                ? options.binding
                : "ready",
          } as OrchestrationV2ProviderSession;
          return {
            runtimeRequests: options.requests ?? [],
            turnItems: options.items ?? [],
            providerThreads: options.binding === "missing_thread" ? [] : [providerThread],
            providerSessions: options.binding === "detached" ? [] : [binding],
          } as unknown as ProjectionRecords<(typeof fields)[number]>;
        }),
      sendToThread: (input) =>
        Effect.sync(() => {
          sends.push(input);
          return {
            run: { id: RunId.make("run-1") },
            delivery: "started",
          } as unknown as ThreadManagementSendResult;
        }),
    }),
    Layer.mock(ThreadLaunchService)({
      launch: () =>
        Effect.sync(() => {
          launches += 1;
        }).pipe(Effect.andThen(Effect.die("unexpected launch"))),
    }),
    Layer.mock(ProjectService)({
      getById: (projectId) =>
        Effect.succeed(
          Option.some({ id: projectId, title: "Work", defaultModelSelection: null } as Project),
        ),
    }),
  );
  const toolkit = yield* VoiceToolkit.pipe(
    Effect.provide(VoiceToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof VoiceToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    caller: ThreadId = SESSION_THREAD,
    scope: Partial<McpInvocationScope> = {},
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!),
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        threadId: caller,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
        ...scope,
      }),
      Effect.provide(dependencies),
    );
  return {
    call,
    sends,
    launches: () => launches,
    confirmations: () => confirmations,
    recordReads: () => recordReads,
    delivered,
  };
});

describe("voice toolkit handlers", () => {
  it.effect("encodes nonempty notice and agenda tool results as MCP JSON", () =>
    Effect.gen(function* () {
      const at = DateTime.makeUnsafe("2026-09-30T12:00:00Z");
      const notice: VoiceNotice = {
        id: "notice-1",
        kind: "input",
        threadId: TARGET_THREAD,
        threadTitle: "Target",
        text: "Target needs your answer.",
        createdAt: at,
      };
      const item: VoiceAgendaItem = {
        id: "topic-1",
        kind: "topic",
        threadId: null,
        title: "Later",
        detail: "Discuss later.",
        status: "open",
        openedAt: at,
        closedAt: null,
      };
      const harness = yield* makeHarness({ notices: [notice], agenda: [item] });
      const notices = yield* harness.call("voice_pending_notices", {});
      expect(yield* decodeJson(notices.encodedResult)).toMatchObject({
        notices: [{ createdAt: "2026-09-30T12:00:00.000Z" }],
      });
      expect(harness.delivered).toEqual([notice.id]);
      const agenda = yield* harness.call("voice_agenda_list", {});
      expect(yield* decodeJson(agenda.encodedResult)).toMatchObject({
        items: [{ openedAt: "2026-09-30T12:00:00.000Z", closedAt: null }],
      });
      const opened = yield* harness.call("voice_topic_open", {
        title: item.title,
        detail: item.detail,
      });
      expect(yield* decodeJson(opened.encodedResult)).toMatchObject({
        item: { openedAt: "2026-09-30T12:00:00.000Z", closedAt: null },
      });
    }),
  );

  it.effect("lists and reads user questions from another project with no active tracked run", () =>
    Effect.gen(function* () {
      const item = question("pending");
      const harness = yield* makeHarness({
        requests: [
          request("pending"),
          request("approval", "command"),
          request("resolved", "user_input", "resolved"),
        ],
        items: [item, question("resolved")],
      });
      const listed = yield* harness.call("voice_pending_question_list", {
        threadId: TARGET_THREAD,
      });
      expect(listed.isFailure).toBe(false);
      expect(listed.result).toEqual({
        threadId: TARGET_THREAD,
        requestIds: [RuntimeRequestId.make("pending")],
      });
      const read = yield* harness.call("voice_pending_question_read", {
        threadId: TARGET_THREAD,
        requestId: RuntimeRequestId.make("pending"),
      });
      expect(read.isFailure).toBe(false);
      expect(read.result).toEqual({
        threadId: TARGET_THREAD,
        requestId: RuntimeRequestId.make("pending"),
        questions: item.type === "user_input_request" ? item.questions : [],
      });
      expect(harness.sends).toEqual([]);
      expect(harness.confirmations()).toBe(0);
    }),
  );

  for (const [label, options, caller, scope] of [
    ["ordinary caller", {}, OTHER_THREAD, {}],
    ["ended generation", { live: false }, SESSION_THREAD, {}],
    [
      "archived session",
      { caller: { archivedAt: DateTime.makeUnsafe("2026-09-30T12:00:00Z") } },
      SESSION_THREAD,
      {},
    ],
    [
      "deleted session",
      { caller: { deletedAt: DateTime.makeUnsafe("2026-09-30T12:00:00Z") } },
      SESSION_THREAD,
      {},
    ],
    [
      "wrong provider",
      {},
      SESSION_THREAD,
      { providerInstanceId: ProviderInstanceId.make("other-codex") },
    ],
    ["missing capability", {}, SESSION_THREAD, { capabilities: new Set<never>() }],
    ["detached provider binding", { binding: "detached" }, SESSION_THREAD, {}],
    ["stopped provider binding", { binding: "stopped" }, SESSION_THREAD, {}],
    ["errored provider binding", { binding: "error" }, SESSION_THREAD, {}],
    ["missing provider thread", { binding: "missing_thread" }, SESSION_THREAD, {}],
    ["stopped runtime", { runtimeLive: false }, SESSION_THREAD, {}],
  ] as const) {
    it.effect(
      `denies question discovery and reading for ${label} before reading target records`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness(options);
          for (const result of [
            yield* harness.call(
              "voice_pending_question_list",
              { threadId: TARGET_THREAD },
              caller,
              scope,
            ),
            yield* harness.call(
              "voice_pending_question_read",
              { threadId: TARGET_THREAD, requestId: RuntimeRequestId.make("pending") },
              caller,
              scope,
            ),
          ]) {
            expect(result.isFailure).toBe(true);
            expect(result.result).toMatchObject({ code: "capability_denied" });
          }
          expect(harness.recordReads()).toBe(0);
        }),
    );
  }

  it.effect(
    "refuses missing, resolved, expired, cancelled, approval and unmatched question IDs",
    () =>
      Effect.gen(function* () {
        const ids = ["missing", "resolved", "expired", "cancelled", "approval", "no-item"];
        const harness = yield* makeHarness({
          requests: [
            request("resolved", "user_input", "resolved"),
            request("expired", "user_input", "expired"),
            request("cancelled", "user_input", "cancelled"),
            request("approval", "command"),
            request("no-item"),
          ],
          items: ids.filter((id) => id !== "no-item").map(question),
        });
        for (const id of ids) {
          const result = yield* harness.call("voice_pending_question_read", {
            threadId: TARGET_THREAD,
            requestId: RuntimeRequestId.make(id),
          });
          expect(result.isFailure).toBe(true);
          expect(result.result).toMatchObject({ code: "invalid_request" });
        }
        expect(harness.sends).toEqual([]);
      }),
  );

  it.effect("refuses question reads for a missing target", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ missingTarget: true });
      const result = yield* harness.call("voice_pending_question_read", {
        threadId: TARGET_THREAD,
        requestId: RuntimeRequestId.make("pending"),
      });
      expect(result.result).toMatchObject({ code: "thread_not_found" });
      expect(harness.recordReads()).toBe(0);
    }),
  );

  it.effect("refuses a caller that is not a live voice session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("voice_agenda_list", {}, OTHER_THREAD);
      expect(result.isFailure).toBe(true);
      expect(result.result).toMatchObject({ code: "capability_denied" });
    }),
  );

  it.effect("does not send without a spoken yes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ transcript: [] });
      const result = yield* harness.call("voice_send", { threadId: TARGET_THREAD, text: DRAFT });
      expect(result.result).toMatchObject({ status: "needs_spoken_yes" });
      expect(harness.sends).toEqual([]);
    }),
  );

  it.effect("sends to a thread in another project after a spoken yes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        transcript: [
          said("user", "Tell the target thread to rebase onto main and rerun the tests."),
          said("assistant", `I'll send to Target: "${DRAFT}" Should I send it?`),
          said("user", "Yes, send it."),
        ],
      });
      const result = yield* harness.call("voice_send", { threadId: TARGET_THREAD, text: DRAFT });
      expect(result.result).toMatchObject({ status: "sent", threadId: TARGET_THREAD });
      expect(harness.sends).toHaveLength(1);
      expect(harness.sends[0]).toMatchObject({
        projectId: WORK_PROJECT,
        threadId: TARGET_THREAD,
        senderThreadId: SESSION_THREAD,
        text: DRAFT,
        mode: "auto",
      });
      // The same yes can't approve a second send.
      const again = yield* harness.call("voice_send", { threadId: TARGET_THREAD, text: DRAFT });
      expect(again.result).toMatchObject({ status: "needs_spoken_yes" });
      expect(harness.sends).toHaveLength(1);
    }),
  );

  it.effect("launches nothing when the user denies on screen", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ approve: false });
      const result = yield* harness.call("voice_launch", {
        projectId: WORK_PROJECT,
        title: "Audit",
        message: "Review the change",
      });
      expect(result.result).toEqual({ status: "denied" });
      expect(harness.confirmations()).toBe(1);
      expect(harness.launches()).toBe(0);
    }),
  );
});
