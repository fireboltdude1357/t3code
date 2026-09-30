import { EnvironmentId, ThreadId, type VoiceSessionEvent } from "@t3tools/contracts";
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
    expect(voiceSessionReducer(reconnecting, answer(2))).toMatchObject({
      status: "live",
      liveAttempt: 2,
      failures: 0,
    });
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
