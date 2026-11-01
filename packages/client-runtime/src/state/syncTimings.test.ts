import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import { v2Projection, v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";
import { makeShellSyncTiming, makeThreadOpenTiming } from "./syncTimings.ts";

const capture = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const ended = (name: string) =>
    spans.flatMap((span) =>
      span.name === name && span.status._tag === "Ended"
        ? [{ attributes: Object.fromEntries(span.attributes), exit: span.status.exit }]
        : [],
    );
  return { tracer, ended };
};

describe("syncTimings", () => {
  it.effect("thread open times first content once and each session's catch-up", () => {
    const { tracer, ended } = capture();
    const [first, second] = [{}, {}];
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const timing = yield* makeThreadOpenTiming("env-1", "thread-1");
          yield* timing.subscriptionStarted(first);
          yield* timing.subscriptionStarted(first);
          yield* timing.content("cache", v2Projection);
          yield* timing.content("socket", v2Projection);
          yield* timing.live(Option.some(v2Projection));
          yield* timing.subscriptionStarted(first);
          yield* timing.subscriptionStarted(second);
          yield* timing.live(Option.some(v2Projection));
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const timing = yield* makeThreadOpenTiming("env-1", "thread-2");
          yield* timing.subscriptionStarted(first);
          yield* timing.missing;
        }),
      );

      const firstContent = ended("EnvironmentThreadState.firstContent");
      expect(firstContent).toHaveLength(2);
      expect(firstContent[0]?.attributes).toMatchObject({
        "environment.id": "env-1",
        "thread.source": "cache",
        "thread.messages": v2Projection.messages.length,
      });
      expect(Exit.hasInterrupts(firstContent[1]!.exit)).toBe(true);
      const live = ended("EnvironmentThreadState.live");
      expect(
        live.map(({ attributes, exit }) => [attributes["thread.resume"], Exit.isSuccess(exit)]),
      ).toEqual([
        [false, true],
        [true, false],
        [true, true],
        [false, false],
      ]);
    }).pipe(Effect.provideService(Tracer.Tracer, tracer));
  });

  it.effect("shell sync spans a session's retries and ends on a new session or disconnect", () => {
    const { tracer, ended } = capture();
    const [first, second, third] = [{}, {}, {}];
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const timing = yield* makeShellSyncTiming("env-1", true);
          yield* timing.sessionStarted(first);
          yield* timing.sessionStarted(first);
          yield* timing.httpApplied;
          yield* timing.live(Option.some(v2ShellSnapshot));
          yield* timing.live(Option.some(v2ShellSnapshot));
          yield* timing.sessionStarted(second);
          yield* timing.disconnected;
          yield* timing.sessionStarted(third);
        }),
      );

      const live = ended("EnvironmentShellState.live");
      expect(live.map(({ exit }) => Exit.isSuccess(exit))).toEqual([true, false, false]);
      expect(live[0]?.attributes).toEqual({
        "environment.id": "env-1",
        "shell.cached": true,
        "shell.source": "http",
        "shell.threads": v2ShellSnapshot.threads.length,
        "shell.projects": v2ShellSnapshot.projects.length,
      });
      expect(live[1]?.attributes["shell.source"]).toBeUndefined();
    }).pipe(Effect.provideService(Tracer.Tracer, tracer));
  });
});
