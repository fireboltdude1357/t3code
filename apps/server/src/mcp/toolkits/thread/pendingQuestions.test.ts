import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { VoiceOrchestrator } from "../../../orchestration-v2/voice/VoiceOrchestrator.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ThreadToolkitRegistrationLive } from "../../McpHttpServer.ts";

const SESSION_THREAD = ThreadId.make("voice-session");
const SAME_PROJECT_THREAD = ThreadId.make("voice-project-thread");
const OTHER_PROJECT_THREAD = ThreadId.make("work-project-thread");
const VOICE_PROJECT = ProjectId.make("voice-project");
const WORK_PROJECT = ProjectId.make("work-project");
const QUESTION = RuntimeRequestId.make("question");
const APPROVAL = RuntimeRequestId.make("approval");
const RESOLVED_QUESTION = RuntimeRequestId.make("resolved-question");
const providerInstanceId = ProviderInstanceId.make("codex");
const questions = [{ id: "branch", header: "Branch", question: "Which branch?", options: [] }];
const answers = { branch: "main" };

// These fixtures contain only the fields read by the toolkit and project-scoping service.
const shell = (id: ThreadId, projectId: ProjectId) =>
  ({
    id,
    projectId,
    providerInstanceId,
    activeRunId: RunId.make("active-run"),
    runtimeMode: "full-access",
    interactionMode: "default",
    archivedAt: null,
    deletedAt: null,
  }) as OrchestrationV2ThreadShell;

const projection = (id: ThreadId, projectId: ProjectId) =>
  ({
    thread: shell(id, projectId),
    runtimeRequests: [
      { id: QUESTION, kind: "user_input", status: "pending" },
      { id: APPROVAL, kind: "command", status: "pending" },
      { id: RESOLVED_QUESTION, kind: "user_input", status: "resolved" },
    ],
    turnItems: [
      { type: "user_input_request", requestId: QUESTION, questions },
      { type: "approval_request", requestId: APPROVAL, requestKind: "command" },
    ],
  }) as unknown as OrchestrationV2ThreadProjection;

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "pending-question-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pending-question-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const makeHarness = Effect.fn("makePendingQuestionHarness")(function* () {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const voice = Layer.mock(VoiceOrchestrator)({
    liveSession: (threadId) =>
      Effect.succeed(
        threadId === SESSION_THREAD
          ? Option.some({
              sessionThreadId: SESSION_THREAD,
              generation: 1,
              focusThreadId: OTHER_PROJECT_THREAD,
            })
          : Option.none(),
      ),
  });
  const management = ThreadManagement.layer.pipe(
    Layer.provide(
      Layer.mock(OrchestratorV2)({
        getThreadShell: (id) =>
          Effect.succeed(shell(id, id === OTHER_PROJECT_THREAD ? WORK_PROJECT : VOICE_PROJECT)),
        getThreadRecords: (id) =>
          Effect.succeed(
            projection(id, id === OTHER_PROJECT_THREAD ? WORK_PROJECT : VOICE_PROJECT),
          ),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 42, storedEvents: [] };
          }),
      }),
    ),
  );
  const dependencies = Layer.mergeAll(management, voice, NodeCrypto.layer);
  const server = yield* McpServer.McpServer.pipe(
    Effect.provide(
      ThreadToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(dependencies),
      ),
    ),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    server.callTool({ name, arguments: args }).pipe(
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "test",
        thread: {
          threadId: SESSION_THREAD,
          providerSessionId: "voice-provider-session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(dependencies),
    );
  const liveSession = yield* VoiceOrchestrator.pipe(Effect.provide(voice));
  expect(Option.isSome(yield* liveSession.liveSession(SESSION_THREAD))).toBe(true);
  return { call, dispatched };
});

describe("normal pending-question tools from a live voice session", () => {
  it.effect("lists, reads, and answers a pending question in the calling project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const target = { threadId: SAME_PROJECT_THREAD };
      const listed = yield* harness.call("t3_pending_request_list", target);
      expect(listed.structuredContent).toEqual({ requestIds: [QUESTION] });
      const read = yield* harness.call("t3_pending_request_read", {
        ...target,
        requestId: QUESTION,
      });
      expect(read.structuredContent).toEqual({ requestId: QUESTION, questions });
      const responded = yield* harness.call("t3_pending_request_respond", {
        ...target,
        requestId: QUESTION,
        answers,
      });
      expect(responded.structuredContent).toEqual({ sequence: 42 });
      expect(harness.dispatched).toHaveLength(1);
      expect(harness.dispatched[0]).toMatchObject({
        type: "runtime-request.respond",
        threadId: SAME_PROJECT_THREAD,
        requestId: QUESTION,
        answers,
      });
    }),
  );

  it.effect("cannot answer an approval through the normal question response tool", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("t3_pending_request_respond", {
        threadId: SAME_PROJECT_THREAD,
        requestId: APPROVAL,
        answers: { approval: "yes" },
      });
      // Declared tool failures arrive as `isError` with the payload as JSON text.
      const text = result.content[0];
      expect(result.isError).toBe(true);
      expect(text?.type === "text" ? JSON.parse(text.text) : undefined).toMatchObject({
        code: "invalid_request",
      });
      expect(harness.dispatched).toEqual([]);
    }),
  );
});
