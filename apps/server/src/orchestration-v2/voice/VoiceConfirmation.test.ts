import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isSpokenConfirmation } from "./VoiceConfirmation.ts";
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
