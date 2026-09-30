import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_VOICE_CALL_STATE,
  voiceCallReducer,
  type VoiceCallAction,
  type VoiceCallState,
} from "./voiceCallState";

const answer: VoiceCallAction = {
  type: "server",
  event: { type: "answer", forkThreadId: ThreadId.make("fork"), sdpAnswer: "v=0" },
};

function run(...actions: ReadonlyArray<VoiceCallAction>): VoiceCallState {
  return actions.reduce(voiceCallReducer, INITIAL_VOICE_CALL_STATE);
}

describe("voiceCallReducer", () => {
  it("goes live on the answer and stays ended once the server ends the call", () => {
    expect(run(answer)).toEqual({ phase: "live", muted: false, transcript: null });
    expect(
      run(answer, { type: "server", event: { type: "ended", reason: "sent" } }, answer, {
        type: "failed",
        message: "late",
      }),
    ).toEqual({ phase: "ended", reason: "sent", message: null });
  });

  it("reports a stream that stops without an ended event as closed, and failures as errors", () => {
    expect(run(answer, { type: "stream-completed" })).toEqual({
      phase: "ended",
      reason: "closed",
      message: null,
    });
    expect(run({ type: "failed", message: "Not connected." })).toEqual({
      phase: "ended",
      reason: "error",
      message: "Not connected.",
    });
  });

  it("keeps the assistant's current line from GPT-Live transcript events", () => {
    const chunk = (text: string): VoiceCallAction => ({
      type: "realtime",
      event: { type: "output_transcript.added", item: { text } },
    });
    const turnDone = (role: string, transcript: string): VoiceCallAction => ({
      type: "realtime",
      event: { type: "turn.done", turn: { role, transcript } },
    });
    const state = run(answer, chunk(" Draft: "), chunk("ship it."));
    expect(state).toMatchObject({ transcript: { text: " Draft: ship it.", done: false } });
    const finished = voiceCallReducer(state, turnDone("assistant", " Draft: ship it."));
    expect(finished).toMatchObject({ transcript: { text: "Draft: ship it.", done: true } });
    // The user's turn leaves the line alone; the next assistant chunk starts a new one.
    expect(voiceCallReducer(finished, turnDone("user", "Yes"))).toBe(finished);
    expect(voiceCallReducer(finished, chunk("Sent."))).toMatchObject({
      transcript: { text: "Sent.", done: false },
    });
  });
});
