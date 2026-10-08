import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as RuntimePolicy from "../RuntimePolicy.ts";

/**
 * Voice session threads, from creation until they are archived. It sits below
 * the runtime policy and the orchestrator so neither depends on the other.
 * A thread is registered before its setup turn, so that turn already runs
 * with the voice policy.
 */
export class VoiceSessionRegistry extends Context.Service<
  VoiceSessionRegistry,
  {
    readonly register: (sessionThreadId: ThreadId) => Effect.Effect<void>;
    readonly unregister: (sessionThreadId: ThreadId) => Effect.Effect<void>;
    readonly has: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("t3/orchestration-v2/voice/VoiceSessionRegistry") {}

export const layer = Layer.effect(
  VoiceSessionRegistry,
  Effect.gen(function* () {
    const threads = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
    return VoiceSessionRegistry.of({
      register: (threadId) => Ref.update(threads, (current) => new Set(current).add(threadId)),
      unregister: (threadId) =>
        Ref.update(threads, (current) => {
          const updated = new Set(current);
          updated.delete(threadId);
          return updated;
        }),
      has: (threadId) => Ref.get(threads).pipe(Effect.map((current) => current.has(threadId))),
    });
  }),
);

/**
 * With approvals off Codex denies every tool that asks, so the session agent
 * gets exactly the voice tools plus a few read-only T3 tools. The voice tools
 * check their own gates (a spoken or on-screen yes) before writing anything.
 */
export const VOICE_SESSION_TOOLS = [
  "voice_threads",
  "voice_thread_read",
  "voice_pending_question_list",
  "voice_pending_question_read",
  "voice_pending_notices",
  "voice_agenda_list",
  "voice_topic_open",
  "voice_topic_close",
  "voice_send",
  "voice_launch",
  "voice_interrupt",
  "voice_confirmations",
  "voice_approve",
  "t3_project_list",
  "t3_environment_read",
];

/**
 * Runs voice session threads read-only with approvals off. Nobody can answer
 * an approval mid-call, and the voice model starts turns T3 does not track, so
 * an approval request would stall the session. Codex keeps these turn settings
 * for the turns the voice model starts later.
 */
export const runtimePolicyLayer: Layer.Layer<
  RuntimePolicy.RuntimePolicyV2,
  never,
  RuntimePolicy.RuntimePolicyV2 | VoiceSessionRegistry
> = Layer.effect(
  RuntimePolicy.RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicy.RuntimePolicyV2;
    const registry = yield* VoiceSessionRegistry;
    return RuntimePolicy.RuntimePolicyV2.of({
      resolve: (input) =>
        Effect.gen(function* () {
          const policy = yield* base.resolve(input);
          return (yield* registry.has(input.thread.id))
            ? {
                ...policy,
                approvalPolicy: "never",
                sandboxPolicy: { type: "readOnly" },
                preapprovedT3McpTools: VOICE_SESSION_TOOLS,
              }
            : policy;
        }),
    });
  }),
);
