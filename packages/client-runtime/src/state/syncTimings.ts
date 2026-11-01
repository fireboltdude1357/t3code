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

/** One span per session: a retry on the same session keeps it, a new session abandons it. */
const makeSessionMilestone = Effect.fnUntraced(function* (name: string, attributes: Attributes) {
  let pending: { readonly span: Tracer.Span; readonly session: object } | undefined;
  const take = () => {
    const span = pending?.span;
    pending = undefined;
    return span;
  };
  const abandonPending = Effect.suspend(() => {
    const span = take();
    return span === undefined ? Effect.void : abandon(span);
  });
  yield* Effect.addFinalizer(() => abandonPending);
  return {
    // Untraced for the same reason as startMilestone.
    start: Effect.fnUntraced(function* (session: object, extra?: Attributes) {
      if (pending?.session === session) return false;
      yield* abandonPending;
      const span = yield* Effect.makeSpan(name, { attributes: { ...attributes, ...extra } });
      pending = { span, session };
      return true;
    }),
    reach: (extra: () => Attributes) =>
      Effect.suspend(() => {
        const span = take();
        return span === undefined ? Effect.void : reach(span, extra());
      }),
    abandon: abandonPending,
  };
});

export type ThreadContentSource = "memory" | "cache" | "http" | "socket";

const threadSize = (thread: OrchestrationV2ThreadProjection) => ({
  "thread.messages": thread.messages.length,
  "thread.items": thread.visibleTurnItems.length,
});

/** Times a thread open to its first projection shown, and each subscription to its completion marker. */
export const makeThreadOpenTiming = Effect.fnUntraced(function* (
  environmentId: string,
  threadId: string,
) {
  const attributes = { "environment.id": environmentId, "thread.id": threadId };
  const firstContent = yield* startMilestone("EnvironmentThreadState.firstContent", attributes);
  const live = yield* makeSessionMilestone("EnvironmentThreadState.live", attributes);
  let subscribed = false;
  return {
    content: (source: ThreadContentSource, thread: OrchestrationV2ThreadProjection) =>
      reach(firstContent, { "thread.source": source, ...threadSize(thread) }),
    subscriptionStarted: (session: object) =>
      Effect.suspend(() => {
        const resume = subscribed;
        subscribed = true;
        return live.start(session, { "thread.resume": resume });
      }),
    live: (thread: Option.Option<OrchestrationV2ThreadProjection>) =>
      live.reach(() => (Option.isSome(thread) ? threadSize(thread.value) : {})),
    missing: Effect.andThen(abandon(firstContent), live.abandon),
  };
});

/** Times each session's shell, from its first subscription to the completion marker. */
export const makeShellSyncTiming = Effect.fnUntraced(function* (
  environmentId: string,
  cachedShown: boolean,
) {
  const live = yield* makeSessionMilestone("EnvironmentShellState.live", {
    "environment.id": environmentId,
    "shell.cached": cachedShown,
  });
  let source: "http" | "socket" = "socket";
  return {
    sessionStarted: (session: object) =>
      live.start(session).pipe(
        Effect.map((started) => {
          if (started) source = "socket";
        }),
      ),
    httpApplied: Effect.sync(() => {
      source = "http";
    }),
    disconnected: live.abandon,
    live: (snapshot: Option.Option<OrchestrationV2ShellSnapshot>) =>
      live.reach(() => ({
        "shell.source": source,
        ...(Option.isSome(snapshot)
          ? {
              "shell.threads": snapshot.value.threads.length,
              "shell.projects": snapshot.value.projects.length,
            }
          : {}),
      })),
  };
});
