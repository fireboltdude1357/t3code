import { describe, expect, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ServerProvider,
  type VoiceAgendaItem,
  type VoiceConfirmRequest,
  VoiceMcpConfirmationsResult,
  VoiceMcpInterruptResult,
  VoiceMcpLaunchResult,
  type VoiceNotice,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { T3Client } from "../T3Client.ts";
import {
  confirmationReadback,
  makeVoiceConfirmationGate,
  sendReadback,
} from "../VoiceConfirmation.ts";
import { VoiceOrchestrator } from "../VoiceOrchestrator.ts";
import { VoiceStore, type VoiceTranscriptEntry } from "../VoiceStore.ts";
import { VoiceToolkitHandlersLive } from "./handlers.ts";
import { VoiceToolkit } from "./tools.ts";
import { VoiceMcpCaller } from "./VoiceMcpCaller.ts";

const decodeLaunch = Schema.decodeUnknownEffect(Schema.fromJsonString(VoiceMcpLaunchResult));
const decodeInterrupt = Schema.decodeUnknownEffect(Schema.fromJsonString(VoiceMcpInterruptResult));
const decodeConfirmations = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceMcpConfirmationsResult),
);
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);

const SESSION_THREAD = ThreadId.make("voice-session");
const OTHER_THREAD = ThreadId.make("ordinary-thread");
const TARGET_THREAD = ThreadId.make("target-thread");
const WORK_PROJECT = ProjectId.make("work-project");
const DRAFT = "Please rebase onto main and rerun the tests.";
const at = DateTime.makeUnsafe("2026-09-30T12:00:00Z");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

// Only the fields the handlers read.
const shell = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id: TARGET_THREAD,
    projectId: WORK_PROJECT,
    title: "Target",
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    archivedAt: null,
    deletedAt: null,
    activeRunId: RunId.make("target-run"),
    updatedAt: at,
    lineage: { relationshipToParent: null },
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

const project = (overrides: Partial<OrchestrationProjectShell> = {}) =>
  ({
    id: WORK_PROJECT,
    title: "Work",
    workspaceRoot: "/code/work",
    defaultModelSelection: null,
    ...overrides,
  }) as unknown as OrchestrationProjectShell;

const said = (role: VoiceTranscriptEntry["role"], text: string): VoiceTranscriptEntry => ({
  generation: 1,
  role,
  text,
  at,
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
  createdAt: at,
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
  updatedAt: at,
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
  readonly threads?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly requests?: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly items?: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly notices?: ReadonlyArray<VoiceNotice>;
  readonly agenda?: ReadonlyArray<VoiceAgendaItem>;
  readonly providers?: ReadonlyArray<ServerProvider>;
}

/**
 * The real handlers over fakes: an orchestrator whose spoken-yes checks use
 * the real confirmation gate against a settable transcript, and a T3 server
 * that records every command and launch.
 */
const makeHarness = Effect.fn("makeVoiceToolkitHarness")(function* (options: HarnessOptions = {}) {
  const dispatched: Array<OrchestrationV2Command> = [];
  const launches: Array<OrchestrationV2ThreadLaunchInput> = [];
  const delivered: string[] = [];
  let proposals = 0;
  let t3Reads = 0;
  let transcript = options.transcript ?? [];
  let threads = options.threads ?? [shell()];
  const gate = makeVoiceConfirmationGate();
  const now = DateTime.makeUnsafe("2026-09-30T12:00:01Z");
  const pending = new Map<
    string,
    { request: VoiceConfirmRequest; execute: Effect.Effect<string> }
  >();

  const dependencies = Layer.mergeAll(
    Layer.succeed(Crypto.Crypto, testCrypto),
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
      // Issuance binding is the orchestrator's; this checks the readback the handler built.
      claimSpokenSend: ({ readback }) =>
        Effect.sync(() => gate.claim({ transcript, generation: 1, now, readback })),
      pendingConfirmations: () =>
        Effect.succeed([...pending.values()].map(({ request }) => request)),
      proposeAction: (input) =>
        Effect.sync(() => {
          proposals += 1;
          if (options.approve === false) return Option.none();
          const request: VoiceConfirmRequest = {
            id: `pending-${proposals}`,
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
              now,
              readback: confirmationReadback(action.request),
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
      listAgenda: () => Effect.succeed(options.agenda ?? []),
      undeliveredNotices: () => Effect.succeed(options.notices ?? []),
      markDelivered: (ids) =>
        Effect.sync(() => {
          delivered.push(...ids);
        }),
      openTopic: () => Effect.succeed(options.agenda![0]!),
    }),
    Layer.mock(T3Client)({
      environmentId: "environment",
      shell: Effect.sync(() => {
        t3Reads += 1;
        return { projects: options.projects ?? [project()], threads };
      }),
      threadShell: (threadId) =>
        Effect.sync(() => {
          t3Reads += 1;
          return threads.find((thread) => thread.id === threadId) ?? null;
        }),
      threadProjection: () =>
        Effect.sync(() => {
          t3Reads += 1;
          return {
            runtimeRequests: options.requests ?? [],
            turnItems: options.items ?? [],
            messages: [],
          } as unknown as OrchestrationV2ThreadProjection;
        }),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
        }),
      launchThread: (input) =>
        Effect.sync(() => {
          launches.push(input);
          return input.threadId!;
        }),
      providers: Effect.succeed(
        options.providers ?? [
          claudeProvider("claudeAgent", { enabled: false }),
          claudeProvider("claude_vibeproxy"),
        ],
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
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!),
      Effect.provideService(VoiceMcpCaller, { sessionThreadId: caller }),
    );

  /** Calls a tool through a registered MCP server, as Codex would. */
  const mcpCall = (name: keyof typeof VoiceToolkit.tools, params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server.callTool({ name, arguments: params }).pipe(
        Effect.provideService(VoiceMcpCaller, { sessionThreadId: SESSION_THREAD }),
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
        McpServer.toolkit(VoiceToolkit).pipe(
          Layer.provide(VoiceToolkitHandlersLive),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(dependencies),
        ),
      ),
    );

  /** Approves pending request `id` the way the voice model would: readback, then yes. */
  const sayYesTo = (id: string) =>
    Effect.gen(function* () {
      const listed = yield* call("voice_confirmations", {});
      const readback = (listed.result as VoiceMcpConfirmationsResult).requests.find(
        (entry) => entry.request.id === id,
      )?.readback;
      transcript = [said("assistant", readback ?? ""), said("user", "Yes")];
      return yield* call("voice_approve", { requestId: id });
    });

  return {
    call,
    mcpCall,
    sayYesTo,
    dispatched,
    launches,
    delivered,
    proposals: () => proposals,
    t3Reads: () => t3Reads,
    setThreads: (next: ReadonlyArray<OrchestrationV2ThreadShell>) => {
      threads = next;
    },
  };
});

describe("voice toolkit handlers", () => {
  it.effect("encodes nonempty notice and agenda tool results as MCP JSON", () =>
    Effect.gen(function* () {
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

  for (const [label, options, caller] of [
    ["an ordinary caller", {}, OTHER_THREAD],
    ["an ended generation", { live: false }, SESSION_THREAD],
  ] as const) {
    it.effect(`refuses every tool for ${label} before touching T3 or the store`, () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(options);
        const pendingId = RuntimeRequestId.make("pending");
        const results = [
          yield* harness.call("voice_projects", {}, caller),
          yield* harness.call("voice_threads", {}, caller),
          yield* harness.call("voice_thread_read", { threadId: TARGET_THREAD }, caller),
          yield* harness.call("voice_pending_question_list", { threadId: TARGET_THREAD }, caller),
          yield* harness.call(
            "voice_pending_question_read",
            { threadId: TARGET_THREAD, requestId: pendingId },
            caller,
          ),
          yield* harness.call("voice_pending_notices", {}, caller),
          yield* harness.call("voice_agenda_list", {}, caller),
          yield* harness.call("voice_topic_open", { title: "Later", detail: "" }, caller),
          yield* harness.call("voice_topic_close", { id: "topic-1" }, caller),
          yield* harness.call("voice_send", { threadId: TARGET_THREAD, text: DRAFT }, caller),
          yield* harness.call(
            "voice_launch",
            { projectId: WORK_PROJECT, title: "Audit", message: "Review" },
            caller,
          ),
          yield* harness.call("voice_interrupt", { threadId: TARGET_THREAD }, caller),
          yield* harness.call("voice_confirmations", {}, caller),
          yield* harness.call("voice_approve", { requestId: "pending-1" }, caller),
        ];
        for (const result of results) {
          expect(result.isFailure).toBe(true);
          expect(result.result).toMatchObject({ code: "capability_denied" });
        }
        expect(harness.t3Reads()).toBe(0);
        expect(harness.delivered).toEqual([]);
        expect(harness.proposals()).toBe(0);
        expect(harness.dispatched).toEqual([]);
      }),
    );
  }

  it.effect("lists projects and live threads newest first, without subagents or archives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: [
          shell({ id: ThreadId.make("older"), title: "Older" }),
          shell({
            id: ThreadId.make("newer"),
            title: "Newer",
            status: "completed",
            activityRunStatus: "running",
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("q"),
              kind: "user_input",
              createdAt: at,
            },
            updatedAt: DateTime.makeUnsafe("2026-09-30T13:00:00Z"),
          }),
          shell({ id: ThreadId.make("archived"), archivedAt: at }),
          shell({
            id: ThreadId.make("helper"),
            lineage: { relationshipToParent: "subagent" } as OrchestrationV2ThreadShell["lineage"],
          }),
        ],
      });
      expect((yield* harness.call("voice_projects", {})).result).toEqual({
        projects: [{ projectId: WORK_PROJECT, title: "Work", workspaceRoot: "/code/work" }],
      });
      const listed = yield* harness.call("voice_threads", {});
      expect(listed.result).toEqual({
        threads: [
          {
            threadId: ThreadId.make("newer"),
            projectId: WORK_PROJECT,
            projectTitle: "Work",
            title: "Newer",
            // An active run's phase wins over the settled status.
            status: "running",
            needsInput: true,
            updatedAt: "2026-09-30T13:00:00.000Z",
          },
          expect.objectContaining({ threadId: ThreadId.make("older"), needsInput: false }),
        ],
      });
    }),
  );

  it.effect("lists and reads pending user questions only", () =>
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
      expect(harness.dispatched).toEqual([]);
      expect(harness.proposals()).toBe(0);
    }),
  );

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
      }),
  );

  it.effect("refuses reads of a missing or deleted thread", () =>
    Effect.gen(function* () {
      for (const threads of [[], [shell({ deletedAt: at })]]) {
        const harness = yield* makeHarness({ threads });
        const result = yield* harness.call("voice_pending_question_read", {
          threadId: TARGET_THREAD,
          requestId: RuntimeRequestId.make("pending"),
        });
        expect(result.result).toMatchObject({ code: "thread_not_found" });
      }
    }),
  );

  it.effect("returns the exact readback and does not send without a spoken yes to it", () =>
    Effect.gen(function* () {
      for (const transcript of [
        [],
        // A lead-in that negates, or one that adds a condition, voids the readback.
        [
          said(
            "assistant",
            `I won't send it yet. Send to Target. Message: ${DRAFT} Should I send it?`,
          ),
          said("user", "Yes"),
        ],
        [
          said(
            "assistant",
            `Send to Target. Message: ${DRAFT} Once CI is green. Should I send it?`,
          ),
          said("user", "Yes"),
        ],
      ]) {
        const harness = yield* makeHarness({ transcript });
        const result = yield* harness.call("voice_send", { threadId: TARGET_THREAD, text: DRAFT });
        expect(result.result).toMatchObject({
          status: "needs_spoken_yes",
          readback: `Send to Target. Message: ${DRAFT} Should I send it?`,
        });
        expect(harness.dispatched).toEqual([]);
      }
    }),
  );

  it.effect("names the project when another live thread has the same title", () =>
    Effect.gen(function* () {
      const otherProject = ProjectId.make("billing-project");
      const harness = yield* makeHarness({
        projects: [project(), project({ id: otherProject, title: "Billing" })],
        threads: [
          shell(),
          shell({ id: OTHER_THREAD, projectId: otherProject }),
          // Archived and subagent namesakes don't count.
          shell({ id: ThreadId.make("archived"), archivedAt: at }),
          shell({
            id: ThreadId.make("subagent"),
            lineage: { relationshipToParent: "subagent" },
          } as Partial<OrchestrationV2ThreadShell>),
        ],
      });
      const readbacks: string[] = [];
      for (const threadId of [TARGET_THREAD, OTHER_THREAD]) {
        const result = yield* harness.call("voice_send", { threadId, text: DRAFT, mode: "queue" });
        readbacks.push((result.result as { readback: string }).readback);
      }
      expect(readbacks).toEqual([
        `Queue for Target in project Work. Message: ${DRAFT} Should I queue it?`,
        `Queue for Target in project Billing. Message: ${DRAFT} Should I queue it?`,
      ]);
    }),
  );

  it.effect("refuses a spoken send it can't make unambiguous", () =>
    Effect.gen(function* () {
      for (const threads of [
        [shell(), shell({ id: OTHER_THREAD })],
        [shell({ title: "Message drafts" })],
      ]) {
        const harness = yield* makeHarness({
          threads,
          transcript: [said("assistant", sendReadback({ title: "Target", draft: DRAFT }))],
        });
        const result = yield* harness.call("voice_send", { threadId: TARGET_THREAD, text: DRAFT });
        expect(result.isFailure).toBe(true);
        expect(result.result).toMatchObject({ code: "invalid_request" });
        expect(harness.dispatched).toEqual([]);
      }
    }),
  );

  for (const [mode, expected] of [
    [
      undefined,
      {
        delivery: "auto",
        command: {
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "auto",
        },
      },
    ],
    ["queue", { delivery: "queued", command: { dispatchMode: { type: "queue_after_active" } } }],
  ] as const) {
    it.effect(`sends once per spoken yes in ${mode ?? "auto"} mode`, () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          transcript: [
            said("user", "Tell the target thread to rebase onto main and rerun the tests."),
            said(
              "assistant",
              sendReadback({
                title: "Target",
                draft: DRAFT,
                ...(mode === undefined ? {} : { mode }),
              }),
            ),
            said("user", "Yes, send it."),
          ],
        });
        const input = {
          threadId: TARGET_THREAD,
          text: DRAFT,
          ...(mode === undefined ? {} : { mode }),
        };
        const result = yield* harness.call("voice_send", input);
        expect(result.result).toEqual({
          status: "sent",
          threadId: TARGET_THREAD,
          delivery: expected.delivery,
        });
        expect(harness.dispatched).toHaveLength(1);
        expect(harness.dispatched[0]).toMatchObject({
          type: "message.dispatch",
          threadId: TARGET_THREAD,
          text: DRAFT,
          createdBy: "agent",
          ...expected.command,
        });
        if (mode === "queue") expect(harness.dispatched[0]).not.toHaveProperty("deliveryIntent");
        // The same yes can't approve a second send.
        const again = yield* harness.call("voice_send", input);
        expect(again.result).toMatchObject({ status: "needs_spoken_yes" });
        expect(harness.dispatched).toHaveLength(1);
      }),
    );
  }

  it.effect("launches nothing when the confirmation is refused", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ approve: false });
      const result = yield* harness.call("voice_launch", {
        projectId: WORK_PROJECT,
        title: "Audit",
        message: "Review the change",
      });
      expect(result.result).toEqual({ status: "denied" });
      expect(harness.proposals()).toBe(1);
      expect(harness.launches).toEqual([]);
    }),
  );
});

describe("voice_launch", () => {
  it.effect("returns a pending readback and launches only after voice_approve", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const proposed = yield* harness.call("voice_launch", {
        projectId: WORK_PROJECT,
        title: "Audit",
        message: "Review the change",
      });
      expect(proposed.result).toMatchObject({
        status: "needs_approval",
        request: { id: "pending-1", action: "launch", title: 'Start "Audit" in Work?' },
      });
      expect(harness.launches).toEqual([]);

      const approved = yield* harness.sayYesTo("pending-1");
      expect(approved.result).toEqual({
        status: "approved",
        requestId: "pending-1",
        completion: 'Started "Audit" in Work.',
      });
      expect(harness.launches).toHaveLength(1);
      expect(harness.launches[0]).toMatchObject({
        projectId: WORK_PROJECT,
        title: "Audit",
        initialMessage: { text: "Review the change" },
        modelSelection: {
          instanceId: "claude_vibeproxy",
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "high" }],
        },
        runtimeMode: "full-access",
        workspaceStrategy: { type: "root" },
      });
      const duplicate = yield* harness.call("voice_approve", { requestId: "pending-1" });
      expect(duplicate.result).toMatchObject({ status: "unavailable" });
      expect(harness.launches).toHaveLength(1);
    }),
  );

  it.effect("prefers the project's Claude instance when several qualify", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        providers: [claudeProvider("claudeAgent"), claudeProvider("claude_vibeproxy")],
        projects: [
          project({
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("claude_vibeproxy"),
              model: "claude-opus-5-5",
            },
          }),
        ],
      });
      yield* harness.call("voice_launch", {
        projectId: WORK_PROJECT,
        title: "Audit",
        message: "Review the change",
      });
      yield* harness.sayYesTo("pending-1");
      expect(harness.launches[0]?.modelSelection.instanceId).toBe("claude_vibeproxy");
    }),
  );

  it.effect("refuses an unknown project or no working Claude provider with Opus 5.5", () =>
    Effect.gen(function* () {
      for (const options of [
        { projects: [] },
        { providers: [claudeProvider("claude_vibeproxy", { models: [] })] },
        { providers: [claudeProvider("claude_vibeproxy", { status: "error" })] },
      ] satisfies ReadonlyArray<HarnessOptions>) {
        const harness = yield* makeHarness(options);
        const result = yield* harness.call("voice_launch", {
          projectId: WORK_PROJECT,
          title: "Audit",
          message: "Review",
        });
        expect(result.isFailure).toBe(true);
        expect(result.encodedResult).toMatchObject({ code: "invalid_request" });
        expect(harness.proposals()).toBe(0);
        expect(harness.launches).toEqual([]);
      }
    }),
  );
});

describe("voice_interrupt", () => {
  it.effect("interrupts the run that was read back, only after approval", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const proposed = yield* harness.call("voice_interrupt", { threadId: TARGET_THREAD });
      expect(proposed.result).toMatchObject({
        status: "needs_approval",
        threadId: TARGET_THREAD,
        request: { action: "interrupt", threadId: TARGET_THREAD },
      });
      expect(harness.dispatched).toEqual([]);
      const approved = yield* harness.sayYesTo("pending-1");
      expect(approved.result).toMatchObject({ status: "approved" });
      expect(harness.dispatched).toHaveLength(1);
      expect(harness.dispatched[0]).toMatchObject({
        type: "run.interrupt",
        threadId: TARGET_THREAD,
        runId: RunId.make("target-run"),
      });
    }),
  );

  it.effect("an approval cannot stop a replacement run", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("voice_interrupt", { threadId: TARGET_THREAD });
      harness.setThreads([shell({ activeRunId: RunId.make("replacement-run") })]);
      const approved = yield* harness.sayYesTo("pending-1");
      expect(approved.result).toMatchObject({ status: "failed" });
      expect(harness.dispatched).toEqual([]);
    }),
  );

  it.effect("proposes nothing for a thread with no active run", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ threads: [shell({ activeRunId: null })] });
      const result = yield* harness.call("voice_interrupt", { threadId: TARGET_THREAD });
      expect(result.result).toEqual({ threadId: TARGET_THREAD, status: "no_active_run" });
      expect(harness.proposals()).toBe(0);
    }),
  );
});

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
      expect(harness.launches).toEqual([]);
      expect(harness.dispatched).toEqual([]);
    }).pipe(Effect.scoped),
);
