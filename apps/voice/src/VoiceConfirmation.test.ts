import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  confirmationReadback,
  isSpokenConfirmation,
  makeVoiceConfirmationGate,
} from "./VoiceConfirmation.ts";
import type { VoiceTranscriptEntry } from "./VoiceStore.ts";

const draft = "Rename the login handler and add a test for expired tokens.";
const readBack = `I'll send: "rename the login handler and add a test for expired tokens." Should I send it?`;

const say = (...lines: ReadonlyArray<readonly ["user" | "assistant", string]>) =>
  lines.map(([role, text]): VoiceTranscriptEntry => ({
    generation: 1,
    role,
    text,
    at: DateTime.makeUnsafe(0),
  }));

it("accepts a close read-back followed by a plain yes", () => {
  assert.isTrue(isSpokenConfirmation(say(["assistant", readBack], ["user", "Yes."]), draft));
  assert.isTrue(
    isSpokenConfirmation(say(["assistant", readBack], ["user", "Yeah, send it"]), draft),
  );
  // Read-back split across parts, reply split across parts.
  assert.isTrue(
    isSpokenConfirmation(
      say(
        ["assistant", "I'll send: rename the login handler"],
        ["assistant", "and add a test for expired tokens. OK?"],
        ["user", "Sounds"],
        ["user", "good."],
      ),
      draft,
    ),
  );
  // An acknowledgement spoken after the yes does not hide it.
  assert.isTrue(
    isSpokenConfirmation(
      say(["assistant", readBack], ["user", "Go ahead"], ["assistant", "Sending it now."]),
      draft,
    ),
  );
});

it("rejects a loose paraphrase of the draft", () => {
  const paraphrase = "I'll ask it to fix up the auth code and cover token expiry. Good?";
  assert.isFalse(isSpokenConfirmation(say(["assistant", paraphrase], ["user", "Yes"]), draft));
});

it("rejects a yes with a change request or a negation", () => {
  for (const reply of [
    "Yes but change the test name",
    "Yeah, actually wait",
    "No",
    "Don't send it yet",
    "Not yet",
  ]) {
    assert.isFalse(
      isSpokenConfirmation(say(["assistant", readBack], ["user", reply]), draft),
      reply,
    );
  }
  assert.isFalse(
    isSpokenConfirmation(say(["assistant", readBack], ["user", "Yes."], ["user", "Wait."]), draft),
  );
});

it("rejects a missing read-back, a yes before it, or an empty draft", () => {
  assert.isFalse(isSpokenConfirmation(say(["user", "Yes, send it"]), draft));
  assert.isFalse(
    isSpokenConfirmation(say(["assistant", "Want me to send something?"], ["user", "Yes"]), draft),
  );
  assert.isFalse(
    isSpokenConfirmation(
      say(["assistant", "Want me to send it?"], ["user", "Yes"], ["assistant", readBack]),
      draft,
    ),
  );
  // A yes to an earlier read-back does not carry over to a fresh one.
  assert.isFalse(
    isSpokenConfirmation(
      say(["assistant", readBack], ["user", "Yes"], ["assistant", readBack]),
      draft,
    ),
  );
  assert.isFalse(isSpokenConfirmation(say(["assistant", readBack], ["user", "Yes"]), "  ?! "));
});

it("counts a weak yes only as a short reply", () => {
  assert.isTrue(isSpokenConfirmation(say(["assistant", readBack], ["user", "Okay."]), draft));
  assert.isFalse(
    isSpokenConfirmation(
      say(["assistant", readBack], ["user", "Okay, what is the other thread doing?"]),
      draft,
    ),
  );
});

it("requires the read-back to name the target thread when one is given", () => {
  const named = `Send to Auth refactor: "${draft}" Should I send it?`;
  assert.isTrue(
    isSpokenConfirmation(say(["assistant", named], ["user", "Yes"]), draft, "Auth refactor"),
  );
  assert.isFalse(
    isSpokenConfirmation(say(["assistant", readBack], ["user", "Yes"]), draft, "Auth refactor"),
  );
});

it("needs the draft word for word, so a dropped negation fails", () => {
  const unsafe = "Delete the production database.";
  assert.isFalse(
    isSpokenConfirmation(
      say(["assistant", "I'll send: do not keep the production database. OK?"], ["user", "Yes"]),
      unsafe,
    ),
  );
  assert.isFalse(
    isSpokenConfirmation(
      say(["assistant", "I'll send: the production database delete. OK?"], ["user", "Yes"]),
      unsafe,
    ),
  );
});

it("rejects unsure, negative and conditional replies", () => {
  for (const reply of ["I'm not sure", "I cannot confirm", "Maybe yes tomorrow", "Yes but later"]) {
    assert.isFalse(
      isSpokenConfirmation(say(["assistant", readBack], ["user", reply]), draft),
      reply,
    );
  }
});

it("accepts a yes the voice model talked over, as in the live call", () => {
  const live = say(
    ["user", 'Please send this message to the main thread: "Voice four check passed."'],
    [
      "assistant",
      'All right, I\'ll send: "Voice four check passed." to "Voice main thread". Is that correct?',
    ],
    ["user", "Yes"],
    ["assistant", "Okay, sending that"],
    ["user", "That is right"],
    ["assistant", "now."],
    ["user", "Send it."],
    ["assistant", "Sending."],
  );
  assert.isTrue(isSpokenConfirmation(live, "Voice four check passed.", "Voice main thread"));
});

const confirmationNow = DateTime.makeUnsafe(120_000);
const actionRequest = {
  id: "approval-1",
  action: "launch" as const,
  title: 'Start "Audit" in Work?',
  detail: "Review the change",
  expiresAt: DateTime.makeUnsafe(240_000),
};
const actionReadback = confirmationReadback(actionRequest);
const timed = (transcript: ReadonlyArray<VoiceTranscriptEntry>, start = 119_000) =>
  transcript.map((entry, index) => ({ ...entry, at: DateTime.makeUnsafe(start + index) }));
const claimAction = (transcript: ReadonlyArray<VoiceTranscriptEntry>) => ({
  transcript,
  generation: 1,
  now: confirmationNow,
  draft: actionReadback,
  exactReadback: true,
});

it("consumes one reply across sends and actions, including appended reply parts", () => {
  const gate = makeVoiceConfirmationGate();
  const transcript = timed(say(["assistant", actionReadback], ["user", "Yes"]));
  assert.isTrue(gate.claim(claimAction(transcript)));
  assert.isFalse(gate.claim(claimAction(transcript)));
  assert.isFalse(
    gate.claim(
      claimAction([
        ...transcript,
        { ...say(["user", "Go ahead"])[0]!, at: DateTime.makeUnsafe(119_003) },
      ]),
    ),
  );
  // The same reply cannot approve a send whose draft appeared in the action readback.
  assert.isFalse(
    gate.claim({ ...claimAction(transcript), draft: actionRequest.detail, exactReadback: false }),
  );
});

it("allows a new readback and fresh reply after an earlier approval", () => {
  const gate = makeVoiceConfirmationGate();
  const transcript = timed(say(["assistant", actionReadback], ["user", "Yes"]));
  assert.isTrue(gate.claim(claimAction(transcript)));
  assert.isTrue(
    gate.claim(
      claimAction(
        timed(
          say(
            ["assistant", actionReadback],
            ["user", "Yes"],
            ["assistant", actionReadback],
            ["user", "Yes"],
          ),
        ),
      ),
    ),
  );
});

it("requires the entire specific action readback, without an extra action or negation", () => {
  for (const readback of [
    'Start "Audit" in Work?',
    actionReadback.replace("Review the change", "Delete the change"),
    `Do not ${actionReadback}`,
    `${actionReadback} Also stop another thread.`,
    `${actionReadback} ${actionReadback}`,
  ]) {
    assert.isFalse(
      makeVoiceConfirmationGate().claim(
        claimAction(timed(say(["assistant", readback], ["user", "Yes"]))),
      ),
      readback,
    );
  }
  assert.isTrue(
    makeVoiceConfirmationGate().claim(
      claimAction(timed(say(["assistant", actionReadback], ["user", "Yes, please"]))),
    ),
  );
});

it("rejects action objections, old or future replies, old readbacks and other generations", () => {
  const accepted = timed(say(["assistant", actionReadback], ["user", "Yes"]));
  for (const transcript of [
    timed(say(["assistant", actionReadback], ["user", "Yes but wait"])),
    timed(say(["assistant", actionReadback], ["user", "Yes"], ["user", "No"])),
    timed(say(["assistant", actionReadback], ["user", "Yes"]), -1_000),
    timed(say(["assistant", actionReadback], ["user", "Yes"]), 121_000),
    accepted.map((entry) => ({ ...entry, generation: 2 })),
    [{ ...accepted[0]!, at: DateTime.makeUnsafe(-1) }, accepted[1]!],
  ])
    assert.isFalse(makeVoiceConfirmationGate().claim(claimAction(transcript)));
  assert.isFalse(
    makeVoiceConfirmationGate().claim({
      ...claimAction(accepted),
      notBefore: DateTime.makeUnsafe(119_005),
    }),
  );
});

it("a yes for an action cannot approve sending its details as a message", () => {
  const gate = makeVoiceConfirmationGate();
  const transcript = timed(say(["assistant", actionReadback], ["user", "Yes"]));
  assert.isFalse(
    gate.claim({
      ...claimAction(transcript),
      draft: actionRequest.detail,
      targetTitle: "Work",
      exactReadback: false,
    }),
  );
  assert.isTrue(gate.claim(claimAction(transcript)));
});

it("accepts explicit natural action approval phrases and refuses qualified approvals", () => {
  for (const reply of ["I approve", "Yes, I approve this action", "Approve this action, please"]) {
    assert.isTrue(
      makeVoiceConfirmationGate().claim(
        claimAction(timed(say(["assistant", actionReadback], ["user", reply]))),
      ),
      reply,
    );
  }
  for (const reply of [
    "I don't approve",
    "Yes, I approve this action but no",
    "I approve if you change it",
    "I approve this action later",
  ]) {
    assert.isFalse(
      makeVoiceConfirmationGate().claim(
        claimAction(timed(say(["assistant", actionReadback], ["user", reply]))),
      ),
      reply,
    );
  }
});

it("refuses sends from action readbacks following a separate preparation acknowledgement", () => {
  const transcript = timed(
    say(["assistant", "I'll prepare that action."], ["assistant", actionReadback], ["user", "Yes"]),
  );
  const gate = makeVoiceConfirmationGate();
  assert.isFalse(
    gate.claim({
      ...claimAction(transcript),
      draft: actionRequest.detail,
      targetTitle: "Audit",
      exactReadback: false,
    }),
  );
  assert.isTrue(gate.claim(claimAction(transcript)));
});

it("allows only separate harmless preparation entries before an exact canonical readback", () => {
  for (const acknowledgement of ["I'll prepare that action.", "Okay", "One moment"]) {
    assert.isTrue(
      makeVoiceConfirmationGate().claim(
        claimAction(
          timed(
            say(["assistant", acknowledgement], ["assistant", actionReadback], ["user", "Yes"]),
          ),
        ),
      ),
    );
  }
  for (const prefix of [
    "Do not",
    "I'll prepare that action but do not approve",
    "Also delete the project",
  ]) {
    assert.isFalse(
      makeVoiceConfirmationGate().claim(
        claimAction(
          timed(say(["assistant", prefix], ["assistant", actionReadback], ["user", "Yes"])),
        ),
      ),
      prefix,
    );
  }
  assert.isFalse(
    makeVoiceConfirmationGate().claim(
      claimAction(
        timed(say(["assistant", `I'll prepare that action. ${actionReadback}`], ["user", "Yes"])),
      ),
    ),
  );
});

it("requires every canonical readback part after the proposal but excludes an earlier separate ack", () => {
  const split = actionReadback.indexOf(".") + 1;
  const transcript = timed(
    say(
      ["assistant", actionReadback.slice(0, split)],
      ["assistant", actionReadback.slice(split)],
      ["user", "Yes"],
    ),
  );
  assert.isFalse(
    makeVoiceConfirmationGate().claim({
      ...claimAction(transcript),
      notBefore: DateTime.makeUnsafe(119_001),
    }),
  );
  const withEarlyAck = [
    saidForTime("assistant", "I'll prepare that action.", 118_000),
    ...timed(
      say(
        ["assistant", actionReadback.slice(0, split)],
        ["assistant", actionReadback.slice(split)],
        ["user", "Yes"],
      ),
    ),
  ];
  assert.isTrue(
    makeVoiceConfirmationGate().claim({
      ...claimAction(withEarlyAck),
      notBefore: DateTime.makeUnsafe(119_000),
    }),
  );
});

function saidForTime(
  role: VoiceTranscriptEntry["role"],
  text: string,
  at: number,
): VoiceTranscriptEntry {
  return { generation: 1, role, text, at: DateTime.makeUnsafe(at) };
}

it("a long hand-off filler after the yes keeps the approval, a new draft does not", () => {
  const withFiller = timed(
    say(
      ["assistant", "Checking that now."],
      ["assistant", actionReadback],
      ["user", "Yes, I approve this action"],
      // Seen live against the sidecar on 2026-10-02.
      ["assistant", "Okay, one moment. Got it, submitting that approval now."],
    ),
  );
  assert.isTrue(makeVoiceConfirmationGate().claim(claimAction(withFiller)));
  const withNewDraft = timed(
    say(
      ["assistant", actionReadback],
      ["user", "Yes, I approve this action"],
      ["assistant", "Actually, should I also delete the old audit thread first?"],
    ),
  );
  assert.isFalse(makeVoiceConfirmationGate().claim(claimAction(withNewDraft)));
});

it("accepts the separate preparation phrases observed in the live approval flow", () => {
  for (const preparation of [
    // Both seen live against the sidecar on 2026-10-02.
    "Okay, checking one more thing.",
    "Checking that now.",
    "Let me get that ready...",
    "Let me check on that",
    "Just a sec",
    "One sec",
    "Checking",
    "Let me pull that together",
  ]) {
    const transcript = timed(
      say(
        ["assistant", preparation],
        ["assistant", actionReadback],
        ["user", "Yes, I approve this action"],
      ),
    );
    assert.isTrue(
      makeVoiceConfirmationGate().claim({
        ...claimAction(transcript),
        notBefore: DateTime.makeUnsafe(118_000),
      }),
      preparation,
    );
    assert.isFalse(
      makeVoiceConfirmationGate().claim(
        claimAction(
          timed(
            say(
              ["assistant", `${preparation} ${actionReadback}`],
              ["user", "Yes, I approve this action"],
            ),
          ),
        ),
      ),
      preparation,
    );
  }
});
