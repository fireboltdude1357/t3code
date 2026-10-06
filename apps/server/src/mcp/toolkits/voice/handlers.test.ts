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
  type ServerProvider,
  type VoiceConfirmRequest,
  VoiceMcpLaunchResult,
  VoiceMcpInterruptResult,
  VoiceMcpConfirmationsResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import { ThreadLaunchService } from "../../../orchestration-v2/ThreadLaunchService.ts";
import { ProviderSessionManagerV2 } from "../../../orchestration-v2/ProviderSessionManager.ts";
import type { ProviderAdapterV2SessionRuntime } from "../../../orchestration-v2/ProviderAdapter.ts";
import {
  ThreadManagementService,
  type ThreadManagementSendInput,
  type ThreadManagementSendResult,
} from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  confirmationReadback,
  makeVoiceConfirmationGate,
} from "../../../orchestration-v2/voice/VoiceConfirmation.ts";
import { VoiceOrchestrator } from "../../../orchestration-v2/voice/VoiceOrchestrator.ts";
import {
  VoiceStore,
  type VoiceTranscriptEntry,
} from "../../../orchestration-v2/voice/VoiceStore.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import type { ProjectionRecords } from "../../../orchestration-v2/ProjectionStore.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { VoiceToolkitRegistrationLive } from "../../McpHttpServer.ts";
import { VoiceToolkitHandlersLive } from "./handlers.ts";
import { VoiceToolkit } from "./tools.ts";

const decodeLaunch = Schema.decodeUnknownEffect(Schema.fromJsonString(VoiceMcpLaunchResult));
const decodeInterrupt = Schema.decodeUnknownEffect(Schema.fromJsonString(VoiceMcpInterruptResult));
const decodeConfirmations = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceMcpConfirmationsResult),
);

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
// Only the fields the launch model lookup reads.
const claudeProvider = (instanceId: string, overrides: Partial<ServerProvider> = {}) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [{ slug: "claude-opus-5-5" }],
    ...overrides,
  }) as unknown as ServerProvider;

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
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly projectInstance?: string;
  readonly expectedInstance?: string;
}

const makeHarness = Effect.fn("makeVoiceToolkitHarness")(function* (options: HarnessOptions = {}) {
  const sends: Array<ThreadManagementSendInput> = [];
  let launches = 0;
  let confirmations = 0;
  let recordReads = 0;
  const delivered: string[] = [];
  let interruptions = 0;
  let activeRunId = RunId.make("target-run");
  let transcript = options.transcript ?? [];
  const gate = makeVoiceConfirmationGate();
  const pending = new Map<
    string,
    { request: VoiceConfirmRequest; execute: Effect.Effect<string> }
  >();
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
      claimSpokenSend: ({ text, targetTitle }) =>
        Effect.sync(() =>
          gate.claim({
            transcript,
            generation: 1,
            now: DateTime.makeUnsafe("2026-09-30T12:00:01Z"),
            draft: text,
            targetTitle,
          }),
        ),
      pendingConfirmations: () =>
        Effect.succeed([...pending.values()].map(({ request }) => request)),
      proposeAction: (input) =>
        Effect.sync(() => {
          confirmations += 1;
          if (options.approve === false) return Option.none();
          const request: VoiceConfirmRequest = {
            id: `pending-${confirmations}`,
            action: input.action,
            title: input.title,
            detail: input.detail,
            expiresAt: DateTime.makeUnsafe("2026-09-30T12:02:00Z"),
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          };
          pending.set(request.id, { request, execute: input.execute });
          return Option.some(request);
        }),
      approveSpoken: ({ requestId }) =>
        Effect.gen(function* () {
          const action = pending.get(requestId);
          if (action === undefined) return { status: "unavailable" as const, requestId };
          if (
            !gate.claim({
              transcript,
              generation: 1,
              now: DateTime.makeUnsafe("2026-09-30T12:00:01Z"),
              draft: confirmationReadback(action.request),
              exactReadback: true,
            })
          )
            return {
              status: "needs_spoken_yes" as const,
              requestId,
              instruction: "Read back and ask again.",
            };
          pending.delete(requestId);
          return yield* action.execute.pipe(
            Effect.map((completion) => ({ status: "approved" as const, requestId, completion })),
            Effect.catchCause(() => Effect.succeed({ status: "failed" as const, requestId })),
          );
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
              : { ...shell(TARGET_THREAD, WORK_PROJECT), activeRunId }
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
      interruptThread: (input) =>
        Effect.sync(() => {
          expect(input.runId).toBe(RunId.make("target-run"));
          interruptions += 1;
          return { type: "interrupt_requested" } as never;
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
      launch: (input) =>
        Effect.sync(() => {
          expect(input.projectId).toBe(WORK_PROJECT);
          expect(input.initialMessage?.text).toBe("Review the change");
          expect(input.modelSelection).toEqual({
            instanceId: options.expectedInstance ?? "claude_vibeproxy",
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "high" }],
          });
          expect(input.runtimeMode).toBe("full-access");
          launches += 1;
          return { threadId: ThreadId.make("new-thread"), projection: { runs: [] } } as never;
        }),
    }),
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.succeed(
        options.providers ?? [
          claudeProvider("claudeAgent", { enabled: false }),
          claudeProvider("claude_vibeproxy"),
        ],
      ),
    }),
    Layer.mock(ProjectService)({
      getById: (projectId) =>
        Effect.succeed(
          Option.some({
            id: projectId,
            title: "Work",
            defaultModelSelection:
              options.projectInstance === undefined
                ? null
                : { instanceId: options.projectInstance, model: "claude-opus-5-5" },
          } as Project),
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
        requestNamespace: "test",
        thread: {
          threadId: caller,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
        ...scope,
      }),
      Effect.provide(dependencies),
    );
  const mcpCall = (name: keyof typeof VoiceToolkit.tools, params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server.callTool({ name, arguments: params }).pipe(
        Effect.provideService(McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          requestNamespace: "test",
          thread: {
            threadId: SESSION_THREAD,
            providerSessionId: "session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
        Effect.provideService(
          McpSchema.McpServerClient,
          McpSchema.McpServerClient.of({
            clientId: 1,
            protocolVersion: "2025-06-18",
            clientCapabilities: {},
            clientInfo: { name: "voice-test", version: "1" },
            initializePayload: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "voice-test", version: "1" },
            },
            getClient: Effect.die("unused"),
          }),
        ),
      );
    }).pipe(
      Effect.provide(
        VoiceToolkitRegistrationLive.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(dependencies),
        ),
      ),
    );
  return {
    call,
    mcpCall,
    sends,
    launches: () => launches,
    confirmations: () => confirmations,
    recordReads: () => recordReads,
    delivered,
    interruptions: () => interruptions,
    setTranscript: (entries: ReadonlyArray<VoiceTranscriptEntry>) => {
      transcript = entries;
    },
    replaceRun: () => {
      activeRunId = RunId.make("replacement-run");
    },
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
      {
        thread: {
          threadId: SESSION_THREAD,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("other-codex"),
        },
      },
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

it.effect("launch returns a pending readback and executes only after voice_approve", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const proposed = yield* harness.call("voice_launch", {
      projectId: WORK_PROJECT,
      title: "Audit",
      message: "Review the change",
    });
    expect(proposed.result).toMatchObject({
      status: "needs_approval",
      request: { id: "pending-1" },
    });
    expect(harness.launches()).toBe(0);
    const pending = yield* harness.call("voice_confirmations", {});
    expect(pending.result).toMatchObject({ requests: [{ request: { id: "pending-1" } }] });
    const readback = pending.result as { requests: ReadonlyArray<{ readback: string }> };
    harness.setTranscript([said("assistant", readback.requests[0]!.readback), said("user", "Yes")]);
    const approved = yield* harness.call("voice_approve", { requestId: "pending-1" });
    expect(approved.result).toMatchObject({ status: "approved" });
    expect(harness.launches()).toBe(1);
    const duplicate = yield* harness.call("voice_approve", { requestId: "pending-1" });
    expect(duplicate.result).toMatchObject({ status: "unavailable" });
    expect(harness.launches()).toBe(1);
  }),
);

it.effect("launch prefers the project's Claude instance when several qualify", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      providers: [claudeProvider("claudeAgent"), claudeProvider("claude_vibeproxy")],
      projectInstance: "claude_vibeproxy",
      expectedInstance: "claude_vibeproxy",
    });
    yield* harness.call("voice_launch", {
      projectId: WORK_PROJECT,
      title: "Audit",
      message: "Review the change",
    });
    const pending = yield* harness.call("voice_confirmations", {});
    const readback = pending.result as { requests: ReadonlyArray<{ readback: string }> };
    harness.setTranscript([said("assistant", readback.requests[0]!.readback), said("user", "Yes")]);
    yield* harness.call("voice_approve", { requestId: "pending-1" });
    expect(harness.launches()).toBe(1);
  }),
);

it.effect("launch refuses when no working Claude provider offers Opus 5.5", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      providers: [claudeProvider("claude_vibeproxy", { models: [] })],
    });
    const result = yield* harness.call("voice_launch", {
      projectId: WORK_PROJECT,
      title: "Audit",
      message: "Review",
    });
    expect(result.isFailure).toBe(true);
    expect(result.encodedResult).toMatchObject({ code: "invalid_request" });
    expect(harness.confirmations()).toBe(0);
    expect(harness.launches()).toBe(0);
  }),
);

it.effect("an interrupt approval cannot stop a replacement run", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.call("voice_interrupt", { threadId: TARGET_THREAD });
    const pending = yield* harness.call("voice_confirmations", {});
    const readback = pending.result as { requests: ReadonlyArray<{ readback: string }> };
    harness.setTranscript([said("assistant", readback.requests[0]!.readback), said("user", "Yes")]);
    harness.replaceRun();
    const approved = yield* harness.call("voice_approve", { requestId: "pending-1" });
    expect(approved.result).toMatchObject({ status: "failed" });
    expect(harness.interruptions()).toBe(0);
  }),
);

it.effect("an interrupt uses the run that was read back after approval", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.call("voice_interrupt", { threadId: TARGET_THREAD });
    expect(harness.interruptions()).toBe(0);
    const pending = yield* harness.call("voice_confirmations", {});
    const readback = pending.result as { requests: ReadonlyArray<{ readback: string }> };
    harness.setTranscript([said("assistant", readback.requests[0]!.readback), said("user", "Yes")]);
    const approved = yield* harness.call("voice_approve", { requestId: "pending-1" });
    expect(approved.result).toMatchObject({ status: "approved" });
    expect(harness.interruptions()).toBe(1);
  }),
);

it.effect(
  "voice approval requests cross the registered MCP JSON boundary with ISO timestamps",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const launched = yield* harness.mcpCall("voice_launch", {
        projectId: WORK_PROJECT,
        title: "Audit",
        message: "Review the change",
      });
      expect(launched.isError).not.toBe(true);
      const launch = yield* decodeLaunch(
        launched.content.find((entry) => entry.type === "text")?.text,
      );
      expect(launched.structuredContent).toEqual(launch);
      expect(launch).toMatchObject({
        status: "needs_approval",
        request: { expiresAt: "2026-09-30T12:02:00.000Z" },
      });
      const interrupted = yield* harness.mcpCall("voice_interrupt", { threadId: TARGET_THREAD });
      expect(interrupted.isError).not.toBe(true);
      const interrupt = yield* decodeInterrupt(
        interrupted.content.find((entry) => entry.type === "text")?.text,
      );
      expect(interrupted.structuredContent).toEqual(interrupt);
      expect(interrupt).toMatchObject({
        status: "needs_approval",
        request: { expiresAt: "2026-09-30T12:02:00.000Z" },
      });
      const pending = yield* harness.mcpCall("voice_confirmations", {});
      expect(pending.isError).not.toBe(true);
      const decoded = yield* decodeConfirmations(
        pending.content.find((entry) => entry.type === "text")?.text,
      );
      expect(pending.structuredContent).toEqual(decoded);
      expect(decoded.requests).toHaveLength(2);
      expect(decoded.requests.every(({ request }) => typeof request.expiresAt === "string")).toBe(
        true,
      );
      expect(harness.launches()).toBe(0);
      expect(harness.interruptions()).toBe(0);
    }).pipe(Effect.scoped),
);
