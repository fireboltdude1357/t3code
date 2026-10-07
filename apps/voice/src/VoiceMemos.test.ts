import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as VoiceMemos from "./VoiceMemos.ts";
import { VoiceOrchestrator } from "./VoiceOrchestrator.ts";
import { VoiceSessionError } from "./VoiceSessionService.ts";
import { VoiceSpeech } from "./VoiceSpeech.ts";

it.effect("one memo id runs once, and a retry resumes after the last step that worked", () =>
  Effect.gen(function* () {
    const transcribed = yield* Ref.make(0);
    const answered = yield* Ref.make(0);
    const spoken = yield* Ref.make(0);
    const uploaded = yield* Deferred.make<void>();
    const layer = VoiceMemos.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(VoiceSpeech)({
            transcribe: () =>
              Ref.update(transcribed, (count) => count + 1).pipe(
                Effect.andThen(Deferred.await(uploaded)),
                Effect.as("Ship the fix"),
              ),
            // The first reply can't be spoken; the retry's can.
            synthesize: () =>
              Ref.updateAndGet(spoken, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 1
                    ? Effect.fail(new VoiceSessionError({ message: "Couldn't speak the reply." }))
                    : Effect.succeed(new Uint8Array([1, 2, 3])),
                ),
              ),
          }),
          Layer.mock(VoiceOrchestrator)({
            memo: () => Ref.update(answered, (count) => count + 1).pipe(Effect.as("On it.")),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const memos = yield* VoiceMemos.VoiceMemos;
      const input = { memoId: "memo-0001", audio: new Uint8Array([0]) };

      // A retry while the memo runs (a dropped connection) waits for the same attempt.
      const first = yield* memos.submit(input).pipe(Effect.flip, Effect.forkScoped);
      while ((yield* Ref.get(transcribed)) === 0) yield* Effect.yieldNow;
      const retry = yield* memos.submit(input).pipe(Effect.flip, Effect.forkScoped);
      for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow;
      yield* Deferred.succeed(uploaded, undefined);
      assert.strictEqual((yield* Fiber.join(first)).message, "Couldn't speak the reply.");
      assert.strictEqual((yield* Fiber.join(retry)).message, "Couldn't speak the reply.");

      // After the failure, a retry speaks again without asking the agent twice.
      const expected = {
        memoId: "memo-0001",
        transcript: "Ship the fix",
        reply: "On it.",
        audioPath: "/voice/memo/memo-0001/audio",
      };
      assert.deepStrictEqual(yield* memos.submit(input), expected);
      assert.deepStrictEqual(yield* memos.submit(input), expected);
      assert.deepStrictEqual(
        [yield* Ref.get(transcribed), yield* Ref.get(answered), yield* Ref.get(spoken)],
        [1, 1, 2],
      );
      assert.deepStrictEqual(
        Option.getOrUndefined(yield* memos.audio("memo-0001")),
        new Uint8Array([1, 2, 3]),
      );
      assert.isTrue(Option.isNone(yield* memos.audio("memo-unknown")));
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);
