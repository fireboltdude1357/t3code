import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ThreadLaunchService } from "../../../orchestration-v2/ThreadLaunchService.ts";
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
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { VoiceToolkitHandlersLive } from "./handlers.ts";
import { VoiceToolkit } from "./tools.ts";

const SESSION_THREAD = ThreadId.make("voice-session");
const OTHER_THREAD = ThreadId.make("ordinary-thread");
const TARGET_THREAD = ThreadId.make("target-thread");
const WORK_PROJECT = ProjectId.make("work-project");
const DRAFT = "Please rebase onto main and rerun the tests.";

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
    deletedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

const said = (role: VoiceTranscriptEntry["role"], text: string): VoiceTranscriptEntry => ({
  generation: 1,
  role,
  text,
  at: DateTime.makeUnsafe("2026-09-30T12:00:00Z"),
});

interface HarnessOptions {
  readonly transcript?: ReadonlyArray<VoiceTranscriptEntry>;
  readonly approve?: boolean;
}

const makeHarness = Effect.fn("makeVoiceToolkitHarness")(function* (options: HarnessOptions = {}) {
  const sends: Array<ThreadManagementSendInput> = [];
  let launches = 0;
  let confirmations = 0;
  const dependencies = Layer.mergeAll(
    Layer.succeed(Crypto.Crypto, testCrypto),
    Layer.mock(VoiceOrchestrator)({
      liveSession: (threadId) =>
        Effect.succeed(
          threadId === SESSION_THREAD
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
      listAgenda: () => Effect.succeed([]),
    }),
    Layer.mock(ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          id === TARGET_THREAD
            ? shell(TARGET_THREAD, WORK_PROJECT)
            : shell(id, ProjectId.make("voice-project")),
        ),
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
      }),
      Effect.provide(dependencies),
    );
  return {
    call,
    sends,
    launches: () => launches,
    confirmations: () => confirmations,
  };
});

describe("voice toolkit handlers", () => {
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
