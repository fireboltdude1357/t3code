import { ThreadId, type VoiceMemoReply } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "@effect/vitest";

import {
  INITIAL_VOICE_MEMO_STATE,
  readVoiceMemoResponse,
  retryWhileOffline,
  VoiceMemoOffline,
  VoiceMemoRejected,
  voiceMemoReducer,
  type VoiceMemoAction,
  type VoiceMemoRequestError,
  type VoiceMemoState,
} from "./voiceMemoState";

const focus = ThreadId.make("thread-1");
const memo = { id: "memo-1", fileUri: "file:///memo-1.m4a", focusThreadId: focus };
const reply: VoiceMemoReply = {
  memoId: "memo-1",
  transcript: "What's running?",
  reply: "Two threads are running.",
  audioPath: "/voice/memo/memo-1/reply",
};

function run(actions: ReadonlyArray<VoiceMemoAction>, from = INITIAL_VOICE_MEMO_STATE) {
  return actions.reduce(voiceMemoReducer, from);
}

/** Opens on a thread and records until the first upload starts. */
function sending(): VoiceMemoState {
  const started = run([{ type: "open", focusThreadId: focus }, { type: "record" }]);
  return run(
    [
      { type: "recording-started", session: started.session, at: 0 },
      { type: "send" },
      { type: "recorded", session: started.session, memo },
    ],
    started,
  );
}

function played(): VoiceMemoState {
  const state = sending();
  return run(
    [
      { type: "uploaded", session: state.session },
      { type: "reply-received", session: state.session, reply },
      { type: "reply-downloaded", session: state.session, fileUri: "file:///reply.m4a" },
    ],
    state,
  );
}

describe("voiceMemoReducer", () => {
  it("walks one memo from recording to its reply", () => {
    const state = sending();
    expect(state).toMatchObject({ status: "sending", memo, focusThreadId: focus });

    const waiting = voiceMemoReducer(state, { type: "uploaded", session: state.session });
    expect(waiting.status).toBe("waiting");

    const done = played();
    expect(done).toMatchObject({ status: "playing", reply, replyFileUri: "file:///reply.m4a" });
    expect(voiceMemoReducer(done, { type: "playback-ended", session: done.session }).status).toBe(
      "ready",
    );
  });

  it("drops results from a recording that was replaced", () => {
    const first = sending();
    const next = run(
      [{ type: "reset" }, { type: "record" }],
      voiceMemoReducer(first, { type: "uploaded", session: first.session }),
    );
    const late = voiceMemoReducer(next, { type: "reply-received", session: first.session, reply });
    expect(late).toBe(next);
  });

  it("shows retrying until the next upload gets through", () => {
    const state = sending();
    const retrying = voiceMemoReducer(state, { type: "retrying", session: state.session });
    expect(retrying.retrying).toBe(true);
    expect(voiceMemoReducer(retrying, { type: "uploaded", session: state.session })).toMatchObject({
      status: "waiting",
      retrying: false,
    });

    // A retry after the server already has the memo uploads again.
    const waiting = run(
      [
        { type: "retrying", session: state.session },
        { type: "uploaded", session: state.session },
      ],
      voiceMemoReducer(state, { type: "uploaded", session: state.session }),
    );
    expect(waiting).toMatchObject({ status: "waiting", retrying: false });
  });

  it("retries a failed send with the same recording", () => {
    const state = sending();
    const failed = voiceMemoReducer(state, {
      type: "failed",
      session: state.session,
      stage: "submit",
      message: "Transcription failed.",
    });
    expect(failed).toMatchObject({ status: "failed", memo });

    const retried = voiceMemoReducer(failed, { type: "retry" });
    expect(retried).toMatchObject({ status: "sending", memo, error: null, session: state.session });
  });

  it("retries a failed download without resending the memo", () => {
    const state = run([{ type: "reply-received", session: sending().session, reply }], sending());
    const failed = voiceMemoReducer(state, {
      type: "failed",
      session: state.session,
      stage: "download",
      message: "gone",
    });
    expect(voiceMemoReducer(failed, { type: "retry" })).toMatchObject({
      status: "downloading",
      reply,
    });
  });

  it("records the next memo straight from playback", () => {
    const done = played();
    const next = voiceMemoReducer(done, { type: "record" });
    expect(next).toMatchObject({ status: "starting", session: done.session + 1, reply });

    // Cancelling the new recording returns to the last reply for Replay.
    expect(voiceMemoReducer(next, { type: "cancel-recording" }).status).toBe("ready");
  });

  it("restarts playback for each replay", () => {
    const ready = voiceMemoReducer(played(), { type: "stop-playback" });
    const replay = voiceMemoReducer(ready, { type: "play" });
    expect(replay.status).toBe("playing");
    expect(voiceMemoReducer(replay, { type: "play" }).playback).toBe(replay.playback + 1);
  });

  it("ignores record taps while a memo is in flight", () => {
    const state = sending();
    expect(voiceMemoReducer(state, { type: "record" })).toBe(state);
  });

  it("closing the sheet drops a recording but keeps a memo in flight", () => {
    const recording = run([{ type: "record" }, { type: "recording-started", session: 1, at: 0 }]);
    expect(voiceMemoReducer(recording, { type: "sheet-closed" }).status).toBe("idle");

    const state = sending();
    expect(voiceMemoReducer(state, { type: "sheet-closed" })).toBe(state);
  });
});

describe("readVoiceMemoResponse", () => {
  const read = (status: number, body: string) =>
    Effect.result(readVoiceMemoResponse("memo-1", status, body));

  it.effect("decodes a reply", () =>
    Effect.gen(function* () {
      expect(yield* read(200, JSON.stringify(reply))).toMatchObject({
        _tag: "Success",
        success: reply,
      });
    }),
  );

  it.effect("treats 503 as retryable and other failures as final", () =>
    Effect.gen(function* () {
      expect(yield* read(503, "")).toMatchObject({ failure: { _tag: "VoiceMemoOffline" } });
      expect(yield* read(502, JSON.stringify({ message: "Transcription failed." }))).toMatchObject({
        failure: { _tag: "VoiceMemoRejected", message: "Transcription failed." },
      });
      expect(yield* read(400, "not json")).toMatchObject({
        failure: {
          _tag: "VoiceMemoRejected",
          message: "The voice server answered with status 400.",
        },
      });
    }),
  );

  it.effect("rejects a reply for another memo", () =>
    Effect.gen(function* () {
      expect(yield* read(200, JSON.stringify({ ...reply, memoId: "memo-2" }))).toMatchObject({
        failure: { _tag: "VoiceMemoRejected" },
      });
    }),
  );
});

describe("retryWhileOffline", () => {
  /** An attempt that fails with each queued error in turn, then succeeds. */
  function scripted(errors: ReadonlyArray<VoiceMemoRequestError>) {
    let calls = 0;
    const attempt = Effect.suspend(() => {
      const error = errors[calls];
      calls += 1;
      return error === undefined ? Effect.succeed("reply") : Effect.fail(error);
    });
    return { attempt, calls: () => calls };
  }

  it.effect("backs off 2, 4, 8 s and caps the wait at 15 s", () =>
    Effect.gen(function* () {
      const offline = new VoiceMemoOffline();
      const script = scripted([offline, offline, offline, offline, offline]);
      let retries = 0;
      const fiber = yield* Effect.forkChild(
        retryWhileOffline(script.attempt, () => {
          retries += 1;
        }),
      );
      yield* TestClock.adjust(Duration.seconds(2));
      expect(script.calls()).toBe(2);
      yield* TestClock.adjust(Duration.seconds(4));
      expect(script.calls()).toBe(3);
      yield* TestClock.adjust(Duration.seconds(8));
      expect(script.calls()).toBe(4);
      yield* TestClock.adjust(Duration.seconds(14));
      expect(script.calls()).toBe(4);
      yield* TestClock.adjust(Duration.seconds(1));
      expect(script.calls()).toBe(5);
      yield* TestClock.adjust(Duration.seconds(15));
      expect(yield* Fiber.join(fiber)).toBe("reply");
      expect(retries).toBe(5);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not retry a rejection", () =>
    Effect.gen(function* () {
      const script = scripted([new VoiceMemoRejected({ message: "No speech." })]);
      const exit = yield* Effect.exit(retryWhileOffline(script.attempt, () => {}));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(script.calls()).toBe(1);
    }),
  );

  it.effect("gives up after about ten minutes offline", () =>
    Effect.gen(function* () {
      const script = scripted(Array.from({ length: 100 }, () => new VoiceMemoOffline()));
      const fiber = yield* Effect.forkChild(retryWhileOffline(script.attempt, () => {}));
      yield* TestClock.adjust(Duration.minutes(11));
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      // 2 + 4 + 8 s, then one attempt every 15 s until 10 minutes have passed.
      expect(script.calls()).toBeGreaterThan(35);
      expect(script.calls()).toBeLessThan(45);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
