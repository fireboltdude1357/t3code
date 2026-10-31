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
  it.effect("thread open ends each milestone once, with the first content source", () => {
    const { tracer, ended } = capture();
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const timing = yield* makeThreadOpenTiming("env-1", "thread-1");
          yield* timing.content("cache", v2Projection);
          yield* timing.content("socket", v2Projection);
          yield* timing.live(Option.some(v2Projection));
          yield* timing.live(Option.some(v2Projection));
        }),
      );
      yield* Effect.scoped(makeThreadOpenTiming("env-1", "thread-2"));

      const firstContent = ended("EnvironmentThreadState.firstContent");
      const live = ended("EnvironmentThreadState.live");
      expect(firstContent).toHaveLength(2);
      expect(live).toHaveLength(2);
      expect(firstContent[0]?.attributes).toMatchObject({
        "environment.id": "env-1",
        "thread.source": "cache",
        "thread.messages": v2Projection.messages.length,
      });
      expect(live[0]?.attributes["thread.source"]).toBe("cache");
      expect(Exit.isSuccess(live[0]!.exit)).toBe(true);
      expect(Exit.hasInterrupts(live[1]!.exit)).toBe(true);
    }).pipe(Effect.provideService(Tracer.Tracer, tracer));
  });

  it.effect("a new session or a closed scope abandons the pending shell sync", () => {
    const { tracer, ended } = capture();
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const timing = yield* makeShellSyncTiming("env-1", true);
          yield* timing.sessionStarted;
          yield* timing.sessionStarted;
          yield* timing.httpApplied;
          yield* timing.live(Option.some(v2ShellSnapshot));
          yield* timing.live(Option.some(v2ShellSnapshot));
          yield* timing.sessionStarted;
        }),
      );

      const live = ended("EnvironmentShellState.live");
      expect(live).toHaveLength(3);
      expect(Exit.hasInterrupts(live[0]!.exit)).toBe(true);
      expect(Exit.hasInterrupts(live[2]!.exit)).toBe(true);
      expect(live[1]?.attributes).toEqual({
        "environment.id": "env-1",
        "shell.cached": true,
        "shell.source": "http",
        "shell.threads": v2ShellSnapshot.threads.length,
        "shell.projects": v2ShellSnapshot.projects.length,
      });
    }).pipe(Effect.provideService(Tracer.Tracer, tracer));
  });
});
