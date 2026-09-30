import type { ThreadId, VoiceCallEndReason } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as RuntimePolicy from "./RuntimePolicy.ts";

export interface VoiceCallEnd {
  readonly reason: VoiceCallEndReason;
  readonly message?: string;
}

/** A fork with a live voice call. `end` settles the call. */
export interface ActiveVoiceFork {
  readonly parentThreadId: ThreadId;
  readonly end: Deferred.Deferred<VoiceCallEnd>;
}

/**
 * Live voice forks, shared by the call service, the runtime policy and the MCP
 * send check. It sits below all three so none of them depend on each other.
 */
export interface VoiceForkRegistryShape {
  readonly register: (forkThreadId: ThreadId, fork: ActiveVoiceFork) => Effect.Effect<void>;
  readonly unregister: (forkThreadId: ThreadId) => Effect.Effect<void>;
  readonly get: (forkThreadId: ThreadId) => Effect.Effect<Option.Option<ActiveVoiceFork>>;
}

export class VoiceForkRegistry extends Context.Service<VoiceForkRegistry, VoiceForkRegistryShape>()(
  "t3/orchestration-v2/VoiceForkRegistry",
) {}

export const layer = Layer.effect(
  VoiceForkRegistry,
  Effect.gen(function* () {
    const forks = yield* Ref.make(new Map<ThreadId, ActiveVoiceFork>());
    return VoiceForkRegistry.of({
      register: (forkThreadId, fork) =>
        Ref.update(forks, (current) => new Map(current).set(forkThreadId, fork)),
      unregister: (forkThreadId) =>
        Ref.update(forks, (current) => {
          const updated = new Map(current);
          updated.delete(forkThreadId);
          return updated;
        }),
      get: (forkThreadId) =>
        Ref.get(forks).pipe(
          Effect.map((current) => Option.fromNullishOr(current.get(forkThreadId))),
        ),
    });
  }),
);

/**
 * Runs live voice forks read-only with approvals off. Nobody can answer an
 * approval during a call, and the voice model starts turns T3 does not track,
 * so an approval request would stall the fork. Codex keeps these turn settings
 * for the turns the voice model starts later.
 */
export const runtimePolicyLayer: Layer.Layer<
  RuntimePolicy.RuntimePolicyV2,
  never,
  RuntimePolicy.RuntimePolicyV2 | VoiceForkRegistry
> = Layer.effect(
  RuntimePolicy.RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicy.RuntimePolicyV2;
    const registry = yield* VoiceForkRegistry;
    return RuntimePolicy.RuntimePolicyV2.of({
      resolve: (input) =>
        Effect.gen(function* () {
          const policy = yield* base.resolve(input);
          const fork = yield* registry.get(input.thread.id);
          return Option.isNone(fork)
            ? policy
            : {
                ...policy,
                approvalPolicy: "never",
                sandboxPolicy: { type: "readOnly" },
                // With approvals off Codex denies any tool that asks, so the one
                // tool the fork needs to finish its job is approved up front.
                preapprovedT3McpTools: ["t3_thread_send"],
              };
        }),
    });
  }),
);
