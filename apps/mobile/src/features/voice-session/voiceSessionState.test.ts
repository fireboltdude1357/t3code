import {
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type VoiceNotice,
  type VoiceSessionEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_VOICE_SESSION_STATE,
  RECONNECT_DELAYS_MS,
  voiceSessionReducer,
  type VoiceSessionAction,
  type VoiceSessionState,
} from "./voiceSessionState";

const start: VoiceSessionAction = {
  type: "start",
  environmentId: EnvironmentId.make("env"),
  focusThreadId: ThreadId.make("focus"),
};

const server = (attempt: number, event: VoiceSessionEvent): VoiceSessionAction => ({
  type: "server",
  attempt,
  event,
});

const answer = (attempt: number, generation = attempt): VoiceSessionAction =>
  server(attempt, {
    type: "answer",
    generation,
    sessionThreadId: ThreadId.make(`session-${generation}`),
    sdpAnswer: "v=0",
  });

const ended = (
  attempt: number,
  reason: "hung_up" | "rotated" | "closed" | "error",
): VoiceSessionAction => server(attempt, { type: "ended", reason });

function run(...actions: ReadonlyArray<VoiceSessionAction>): VoiceSessionState {
  return actions.reduce(voiceSessionReducer, INITIAL_VOICE_SESSION_STATE);
}

function notice(
  id: string,
  kind: VoiceNotice["kind"],
  timestamp = 0,
  requestId?: string,
): VoiceNotice {
  return {
    id,
    kind,
    threadId: ThreadId.make("t1"),
    threadTitle: "Fix login",
    text: id,
    createdAt: DateTime.makeUnsafe(timestamp),
    ...(requestId === undefined ? {} : { requestId: RuntimeRequestId.make(requestId) }),
  };
}

const requests = (attempt: number, notices: ReadonlyArray<VoiceNotice>): VoiceSessionAction =>
  server(attempt, { type: "request_notices", notices });

describe("voiceSessionReducer", () => {
  it("goes live on the answer and stops sending the focus thread", () => {
    expect(run(start)).toMatchObject({
      status: "connecting",
      attempt: 1,
      focusThreadId: "focus",
    });
    expect(run(start, answer(1))).toMatchObject({
      status: "live",
      liveAttempt: 1,
      generation: 1,
      sessionThreadId: "session-1",
      focusThreadId: null,
    });
  });

  it("keeps the old generation live while a rotation opens the next one", () => {
    const rotating = run(start, answer(1), server(1, { type: "rotate" }));
    expect(rotating).toMatchObject({ status: "live", attempt: 2, liveAttempt: 1, openDelayMs: 0 });
    // A repeated rotate doesn't open a third generation.
    expect(voiceSessionReducer(rotating, server(1, { type: "rotate" }))).toBe(rotating);
    // The old stream's `rotated` end, before or after the new answer, is expected.
    expect(voiceSessionReducer(rotating, ended(1, "rotated"))).toBe(rotating);
    const rotated = run(start, answer(1), server(1, { type: "rotate" }), answer(2, 2));
    expect(rotated).toMatchObject({ status: "live", liveAttempt: 2, generation: 2 });
    expect(voiceSessionReducer(rotated, ended(1, "rotated"))).toBe(rotated);
    expect(
      voiceSessionReducer(rotated, { type: "generation-lost", attempt: 1, message: null }),
    ).toBe(rotated);
  });

  it("reconnects with backoff after the live generation closes", () => {
    const reconnecting = run(start, answer(1), ended(1, "closed"));
    expect(reconnecting).toMatchObject({
      status: "reconnecting",
      attempt: 2,
      liveAttempt: null,
      failures: 1,
      openDelayMs: RECONNECT_DELAYS_MS[0],
    });
    // An answer alone doesn't clear the count: audio can still fail to connect.
    const answered = voiceSessionReducer(reconnecting, answer(2));
    expect(answered).toMatchObject({ status: "live", liveAttempt: 2, failures: 1 });
    expect(voiceSessionReducer(answered, { type: "audio-connected", attempt: 2 })).toMatchObject({
      failures: 0,
    });
  });

  it("gives up when answers keep arriving but audio never connects", () => {
    let state = run(start, answer(1));
    for (let index = 0; index < RECONNECT_DELAYS_MS.length; index += 1) {
      state = voiceSessionReducer(state, {
        type: "generation-lost",
        attempt: state.attempt,
        message: null,
      });
      state = voiceSessionReducer(state, answer(state.attempt));
    }
    state = voiceSessionReducer(state, {
      type: "generation-lost",
      attempt: state.attempt,
      message: "The call audio connection dropped.",
    });
    expect(state.status).toBe("failed");
  });

  it("gives up after the last reconnect fails", () => {
    let state = run(start, answer(1));
    for (let index = 0; index < RECONNECT_DELAYS_MS.length; index += 1) {
      state = voiceSessionReducer(state, ended(state.attempt, "error"));
      expect(state.status).toBe("reconnecting");
    }
    state = voiceSessionReducer(state, {
      type: "generation-lost",
      attempt: state.attempt,
      message: "Not connected.",
    });
    expect(state).toMatchObject({ status: "failed", message: "Not connected." });
    // Nothing reopens once it gave up; a fresh start does.
    expect(voiceSessionReducer(state, ended(state.attempt, "closed"))).toBe(state);
    expect(voiceSessionReducer(state, start)).toMatchObject({
      status: "connecting",
      attempt: state.attempt + 1,
      failures: 0,
    });
  });

  it("stops reconnecting once the user hangs up", () => {
    const hungUp = run(start, answer(1), { type: "hang-up" });
    expect(hungUp).toMatchObject({ status: "ended", liveAttempt: null });
    expect(voiceSessionReducer(hungUp, ended(1, "closed"))).toBe(hungUp);
    expect(
      voiceSessionReducer(hungUp, { type: "generation-lost", attempt: 1, message: null }),
    ).toBe(hungUp);
  });

  it("does not restart a live session when opened again", () => {
    const live = run(start, answer(1));
    expect(voiceSessionReducer(live, start)).toBe(live);
  });

  it("keeps notices and confirm cards until resolved", () => {
    const createdAt = DateTime.makeUnsafe(0);
    const notice: VoiceSessionEvent = {
      type: "notice",
      notice: {
        id: "n1",
        kind: "completed",
        threadId: ThreadId.make("t1"),
        threadTitle: "Fix login",
        text: "Fix login finished.",
        createdAt,
      },
    };
    const confirm: VoiceSessionEvent = {
      type: "confirm",
      request: {
        id: "c1",
        action: "launch",
        title: "Launch a thread",
        detail: "Refactor the parser",
        expiresAt: createdAt,
      },
    };
    const state = run(start, answer(1), server(1, notice), server(1, notice), server(1, confirm));
    expect(state.notices.map((item) => item.id)).toEqual(["n1"]);
    expect(state.confirms.map((item) => item.id)).toEqual(["c1"]);
    expect(
      voiceSessionReducer(
        state,
        server(1, { type: "confirm_resolved", requestId: "c1", approved: true }),
      ).confirms,
    ).toEqual([]);
    expect(
      voiceSessionReducer(state, { type: "confirm-removed", requestId: "c1" }).confirms,
    ).toEqual([]);
  });

  it("clears a question as soon as the answer's settled snapshot arrives", () => {
    const completed = notice("completed", "completed");
    const question = notice("question", "input", 1, "question-1");
    const approval = notice("approval", "approval", 2, "approval-1");
    const pending = run(
      start,
      answer(1),
      server(1, { type: "notice", notice: completed }),
      requests(1, [question, approval]),
    );
    expect(pending.notices).toEqual([approval, question, completed]);

    const answered = voiceSessionReducer(pending, requests(1, [approval]));
    expect(answered.notices).toEqual([approval, completed]);
    expect(voiceSessionReducer(answered, requests(1, [])).notices).toEqual([completed]);
  });

  it("accepts older servers' attention notices until each generation sends a snapshot", () => {
    const question = notice("legacy-input", "input", 1);
    const approval = notice("approval", "approval", 2, "approval-1");
    const legacy = run(
      start,
      answer(1),
      server(1, { type: "notice", notice: question }),
      server(1, { type: "notice", notice: approval }),
    );
    expect(legacy.notices).toEqual([approval, question]);
    expect(voiceSessionReducer(legacy, server(1, { type: "notice", notice: question }))).toBe(
      legacy,
    );

    const settled = voiceSessionReducer(legacy, requests(1, []));
    const rotating = voiceSessionReducer(settled, server(1, { type: "rotate" }));
    expect(voiceSessionReducer(rotating, server(1, { type: "notice", notice: question }))).toBe(
      rotating,
    );
    const next = voiceSessionReducer(rotating, answer(2));
    expect(voiceSessionReducer(next, requests(1, []))).toBe(next);
    const nextApproval = notice("legacy-approval", "approval", 3);
    expect(
      voiceSessionReducer(next, server(2, { type: "notice", notice: nextApproval })).notices,
    ).toEqual([nextApproval]);
  });

  it("clears legacy and identified requests missed while reconnecting, retaining history", () => {
    const completed = notice("completed", "completed");
    const failed = notice("failed", "failed", 1);
    const live = run(start, answer(1));
    const pending: VoiceSessionState = {
      ...live,
      notices: [
        notice("legacy-input", "input", 4),
        notice("known-approval", "approval", 3, "approval-1"),
        notice("known-input", "input", 2, "question-1"),
        notice("legacy-approval", "approval", 2),
        failed,
        completed,
      ],
    };
    const reconnecting = voiceSessionReducer(pending, ended(1, "closed"));
    const reconnected = voiceSessionReducer(reconnecting, answer(2));
    expect(voiceSessionReducer(reconnected, requests(2, [])).notices).toEqual([failed, completed]);
  });

  it("shows a later distinct question in the same thread after the first is answered", () => {
    const first = notice("question-1", "input", 1, "request-1");
    const second = notice("question-2", "input", 2, "request-2");
    const state = run(start, answer(1), requests(1, [first]), requests(1, []));
    expect(voiceSessionReducer(state, requests(1, [second])).notices).toEqual([second]);
  });

  it("uses the live stream during rotation and ignores its events after the new answer", () => {
    const first = notice("question-1", "input", 1, "request-1");
    const second = notice("question-2", "input", 2, "request-2");
    const rotating = run(start, answer(1), server(1, { type: "rotate" }));
    const pending = voiceSessionReducer(rotating, requests(1, [first]));
    expect(pending.notices).toEqual([first]);
    expect(voiceSessionReducer(pending, requests(2, []))).toBe(pending);

    const replaced = voiceSessionReducer(pending, answer(2));
    const current = voiceSessionReducer(replaced, requests(2, [second]));
    expect(voiceSessionReducer(current, requests(1, []))).toBe(current);
    expect(voiceSessionReducer(current, requests(1, [first]))).toBe(current);
    expect(voiceSessionReducer(current, server(1, { type: "notice", notice: first }))).toBe(
      current,
    );
    expect(
      voiceSessionReducer(
        current,
        server(1, { type: "notice", notice: notice("old-completed", "completed", 3) }),
      ),
    ).toBe(current);

    const settled = voiceSessionReducer(current, requests(2, []));
    expect(voiceSessionReducer(settled, server(2, { type: "notice", notice: second }))).toBe(
      settled,
    );
    expect(voiceSessionReducer(settled, requests(1, [first]))).toBe(settled);
    expect(voiceSessionReducer(settled, answer(1))).toBe(settled);
  });

  it("ignores snapshots and history from a lost stream while reconnecting", () => {
    const pending = run(
      start,
      answer(1),
      requests(1, [notice("question", "input", 1, "request-1")]),
      ended(1, "closed"),
    );
    expect(voiceSessionReducer(pending, requests(1, []))).toBe(pending);
    expect(voiceSessionReducer(pending, requests(2, []))).toBe(pending);
    expect(
      voiceSessionReducer(
        pending,
        server(1, { type: "notice", notice: notice("completed", "completed") }),
      ),
    ).toBe(pending);
  });

  it("does not restore settled requests from delayed individual attention notices", () => {
    const question = notice("question", "input", 1, "request-1");
    const state = run(start, answer(1), requests(1, [question]), requests(1, []));
    for (const delayed of [
      question,
      notice("approval", "approval", 2, "approval-1"),
      notice("legacy-input", "input", 3),
      notice("legacy-approval", "approval", 4),
    ]) {
      expect(voiceSessionReducer(state, server(1, { type: "notice", notice: delayed }))).toBe(
        state,
      );
    }
    const completed = notice("completed", "completed", 5);
    const failed = notice("failed", "failed", 6);
    expect(
      [completed, failed].reduce(
        (previous, item) =>
          voiceSessionReducer(previous, server(1, { type: "notice", notice: item })),
        state,
      ).notices,
    ).toEqual([failed, completed]);
  });

  it("orders snapshots and delayed history by DateTime and caps the combined list", () => {
    const history = Array.from({ length: 15 }, (_, index) =>
      notice(`completed-${index}`, "completed", index * 1_000),
    );
    const pending = Array.from({ length: 15 }, (_, index) =>
      notice(`question-${index}`, "input", (index + 15) * 1_000, `request-${index}`),
    );
    const initial = run(
      start,
      answer(1),
      ...history.map((item) => server(1, { type: "notice", notice: item })),
    );
    const snapshot = voiceSessionReducer(initial, requests(1, pending));
    expect(snapshot.notices).toEqual([...pending.toReversed(), ...history.slice(-5).toReversed()]);
    const delayed = notice("delayed-failure", "failed", 20_500);
    const withHistory = voiceSessionReducer(
      snapshot,
      server(1, { type: "notice", notice: delayed }),
    );
    expect(withHistory.notices).toHaveLength(20);
    expect(withHistory.notices.indexOf(delayed)).toBe(9);
    expect(withHistory.notices.at(-1)?.id).toBe("completed-11");
  });

  it("keeps the assistant's current line from the live generation only", () => {
    const chunk = (attempt: number, text: string): VoiceSessionAction => ({
      type: "realtime",
      attempt,
      event: { type: "output_transcript.added", item: { text } },
    });
    const state = run(start, answer(1), chunk(1, " Draft: "), chunk(1, "ship it."), chunk(2, "x"));
    expect(state.transcript).toEqual({ text: " Draft: ship it.", done: false });
    const finished = voiceSessionReducer(state, {
      type: "realtime",
      attempt: 1,
      event: { type: "turn.done", turn: { role: "assistant", transcript: " Draft: ship it." } },
    });
    expect(finished.transcript).toEqual({ text: "Draft: ship it.", done: true });
  });
});
