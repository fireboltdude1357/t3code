import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

/**
 * Session threads and the bearer token each one's Codex uses for the sidecar's
 * MCP endpoint. A token identifies its caller, so a voice tool always knows
 * which session thread is asking.
 */
export interface VoiceSessionRegistryShape {
  readonly register: (sessionThreadId: ThreadId, token: string) => Effect.Effect<void>;
  readonly unregister: (sessionThreadId: ThreadId) => Effect.Effect<void>;
  readonly byToken: (token: string) => Effect.Effect<Option.Option<ThreadId>>;
}

export class VoiceSessionRegistry extends Context.Service<
  VoiceSessionRegistry,
  VoiceSessionRegistryShape
>()("@t3tools/voice/VoiceSessionRegistry") {}

export const layer = Layer.effect(
  VoiceSessionRegistry,
  Effect.gen(function* () {
    const tokens = yield* Ref.make<ReadonlyMap<string, ThreadId>>(new Map());
    return VoiceSessionRegistry.of({
      register: (sessionThreadId, token) =>
        Ref.update(tokens, (current) => new Map(current).set(token, sessionThreadId)),
      unregister: (sessionThreadId) =>
        Ref.update(
          tokens,
          (current) => new Map([...current].filter(([, threadId]) => threadId !== sessionThreadId)),
        ),
      byToken: (token) =>
        Ref.get(tokens).pipe(Effect.map((current) => Option.fromUndefinedOr(current.get(token)))),
    });
  }),
);
