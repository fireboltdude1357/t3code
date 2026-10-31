import type {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";

type Attributes = Readonly<Record<string, string | number | boolean>>;

const endOnce = (span: Tracer.Span, exit: Exit.Exit<void>, attributes?: Attributes) =>
  Effect.map(Clock.currentTimeNanos, (now) => {
    if (span.status._tag === "Ended") return;
    for (const key in attributes) span.attribute(key, attributes[key]);
    span.end(now, exit);
  });

const reach = (span: Tracer.Span, attributes?: Attributes) => endOnce(span, Exit.void, attributes);

const abandon = (span: Tracer.Span) => endOnce(span, Exit.interrupt());

// Untraced: a traced wrapper would become the milestone span's parent.
const startMilestone = Effect.fnUntraced(function* (name: string, attributes: Attributes) {
  const span = yield* Effect.makeSpan(name, { attributes });
  yield* Effect.addFinalizer(() => abandon(span));
  return span;
});

export type ThreadContentSource = "memory" | "cache" | "http" | "socket";

const threadSize = (thread: OrchestrationV2ThreadProjection) => ({
  "thread.messages": thread.messages.length,
  "thread.items": thread.visibleTurnItems.length,
});

/** Times one thread open: to the first projection shown, and to the first completion marker. */
export const makeThreadOpenTiming = Effect.fnUntraced(function* (
  environmentId: string,
  threadId: string,
) {
  const attributes = { "environment.id": environmentId, "thread.id": threadId };
  const firstContent = yield* startMilestone("EnvironmentThreadState.firstContent", attributes);
  const live = yield* startMilestone("EnvironmentThreadState.live", attributes);
  let source: ThreadContentSource | undefined;
  return {
    content: (from: ThreadContentSource, thread: OrchestrationV2ThreadProjection) => {
      source ??= from;
      return reach(firstContent, { "thread.source": from, ...threadSize(thread) });
    },
    live: (thread: Option.Option<OrchestrationV2ThreadProjection>) =>
      reach(live, {
        "thread.source": source ?? "none",
        ...(Option.isSome(thread) ? threadSize(thread.value) : {}),
      }),
  };
});

/** Times each new session's shell, from its first subscription to the completion marker. */
export const makeShellSyncTiming = Effect.fnUntraced(function* (
  environmentId: string,
  cachedShown: boolean,
) {
  let pending: { readonly span: Tracer.Span; source: "http" | "socket" } | undefined;
  yield* Effect.addFinalizer(() => (pending === undefined ? Effect.void : abandon(pending.span)));
  return {
    sessionStarted: Effect.gen(function* () {
      if (pending !== undefined) yield* abandon(pending.span);
      const span = yield* Effect.makeSpan("EnvironmentShellState.live", {
        attributes: { "environment.id": environmentId, "shell.cached": cachedShown },
      });
      pending = { span, source: "socket" };
    }),
    httpApplied: Effect.sync(() => {
      if (pending !== undefined) pending.source = "http";
    }),
    live: (snapshot: Option.Option<OrchestrationV2ShellSnapshot>) =>
      Effect.suspend(() => {
        if (pending === undefined) return Effect.void;
        const { span, source } = pending;
        pending = undefined;
        return reach(span, {
          "shell.source": source,
          ...(Option.isSome(snapshot)
            ? {
                "shell.threads": snapshot.value.threads.length,
                "shell.projects": snapshot.value.projects.length,
              }
            : {}),
        });
      }),
  };
});
