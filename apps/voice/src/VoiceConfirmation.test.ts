import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  confirmationReadback,
  makeVoiceConfirmationGate,
  sendReadback,
} from "./VoiceConfirmation.ts";
import type { VoiceTranscriptEntry } from "./VoiceStore.ts";

const draft = "Rename the login handler and add a test for expired tokens.";
const title = "Auth refactor";
const readBack = sendReadback(title, draft);

const say = (...lines: ReadonlyArray<readonly ["user" | "assistant", string]>) =>
  lines.map(([role, text]): VoiceTranscriptEntry => ({
    generation: 1,
    role,
    text,
    at: DateTime.makeUnsafe(0),
  }));

const confirmationNow = DateTime.makeUnsafe(120_000);
const timed = (transcript: ReadonlyArray<VoiceTranscriptEntry>, start = 119_000) =>
  transcript.map((entry, index) => ({ ...entry, at: DateTime.makeUnsafe(start + index) }));

/** Whether a fresh gate lets `transcript` send `text` to the thread `target`. */
const sends = (transcript: ReadonlyArray<VoiceTranscriptEntry>, text = draft, target = title) =>
  makeVoiceConfirmationGate().claim({
    transcript: timed(transcript),
    generation: 1,
    now: confirmationNow,
    readback: sendReadback(target, text),
  });

it("formats the send readback with the thread, the draft and one question", () => {
  assert.strictEqual(
    readBack,
    "Send to Auth refactor: Rename the login handler and add a test for expired tokens. Should I send it?",
  );
  assert.strictEqual(
    sendReadback(" Work ", " Ship it "),
    "Send to Work: Ship it. Should I send it?",
  );
  assert.strictEqual(sendReadback("Work", "Done?"), "Send to Work: Done? Should I send it?");
});

it("accepts the exact send readback followed by a plain yes", () => {
  assert.isTrue(sends(say(["assistant", readBack], ["user", "Yes."])));
  assert.isTrue(sends(say(["assistant", readBack], ["user", "Yeah, send it"])));
  assert.isTrue(sends(say(["assistant", readBack.toUpperCase()], ["user", "Okay."])));
  // Readback split across parts, reply split across parts.
  assert.isTrue(
    sends(
      say(
        ["assistant", "Send to Auth refactor: rename the login handler"],
        ["assistant", "and add a test for expired tokens. Should I send it?"],
        ["user", "Sounds"],
        ["user", "good."],
      ),
    ),
  );
  // Harmless filler before it, and a hand-off after the yes, as in live calls.
  assert.isTrue(
    sends(
      say(
        ["assistant", "One moment."],
        ["assistant", readBack],
        ["user", "Yes"],
        ["assistant", "Okay, sending that"],
        ["user", "That is right"],
        ["assistant", "Sending."],
      ),
    ),
  );
});

it("rejects free-form or paraphrased send readbacks", () => {
  for (const spoken of [
    `I'll send: "${draft}" to Auth refactor. Should I send it?`,
    `Send to Auth refactor: "${draft}"`,
    "Send to Auth refactor: fix up the auth code and cover token expiry. Should I send it?",
  ])
    assert.isFalse(sends(say(["assistant", spoken], ["user", "Yes"])), spoken);
});

it("rejects readbacks that change the meaning of the draft", () => {
  const unsafe = "Delete the production database.";
  for (const spoken of [
    "Send to Maintenance: Do not delete the production database. Should I send it?",
    "Send to Maintenance: Delete the production database once the backup has been verified. Should I send it?",
    "Send to Maintenance: Delete the production database. Should I send it? Also drop staging.",
  ])
    assert.isFalse(
      sends(say(["assistant", spoken], ["user", "Yes"]), unsafe, "Maintenance"),
      spoken,
    );
  // A short negation in its own entry before the readback is not skipped as filler.
  assert.isFalse(
    sends(
      say(
        ["assistant", "Do not."],
        ["assistant", sendReadback("Maintenance", unsafe)],
        ["user", "Yes"],
      ),
      unsafe,
      "Maintenance",
    ),
  );
  // Dropping a condition the draft has also fails.
  assert.isFalse(
    sends(
      say(["assistant", sendReadback("Maintenance", unsafe)], ["user", "Yes"]),
      "Delete the production database once the backup has been verified.",
      "Maintenance",
    ),
  );
});

it("binds the yes to the named thread", () => {
  const text = "Run the tests.";
  assert.isFalse(
    sends(
      say(["assistant", sendReadback("Frontend tests", text)], ["user", "Yes"]),
      text,
      "Backend tests",
    ),
  );
  // A title word heard only inside the draft does not name the thread.
  assert.isFalse(
    sends(
      say(["assistant", "Send to Auth: Refactor the handler. Should I send it?"], ["user", "Yes"]),
      "Refactor the handler.",
      "Auth refactor",
    ),
  );
});

it("rejects a yes with a change request, a negation or doubt", () => {
  for (const reply of [
    "Yes but change the test name",
    "Yeah, actually wait",
    "No",
    "Don't send it yet",
    "Not yet",
    "I'm not sure",
    "I cannot confirm",
    "Maybe yes tomorrow",
    "Okay, what is the other thread doing?",
  ])
    assert.isFalse(sends(say(["assistant", readBack], ["user", reply])), reply);
  assert.isFalse(sends(say(["assistant", readBack], ["user", "Yes."], ["user", "Wait."])));
});

it("rejects a missing readback, a yes before it, or a question after it", () => {
  assert.isFalse(sends(say(["user", "Yes, send it"])));
  assert.isFalse(
    sends(say(["assistant", "Want me to send it?"], ["user", "Yes"], ["assistant", readBack])),
  );
  // A yes to an earlier readback does not carry over to a fresh one.
  assert.isFalse(sends(say(["assistant", readBack], ["user", "Yes"], ["assistant", readBack])));
  assert.isFalse(
    sends(say(["assistant", readBack], ["assistant", "Also tell Billing?"], ["user", "Yes"])),
  );
});

const actionRequest = {
  id: "approval-1",
  action: "launch" as const,
  title: 'Start "Audit" in Work?',
  detail: "Review the change",
  expiresAt: DateTime.makeUnsafe(240_000),
};
const actionReadback = confirmationReadback(actionRequest);
const claimAction = (transcript: ReadonlyArray<VoiceTranscriptEntry>) => ({
  transcript,
  generation: 1,
  now: confirmationNow,
  readback: actionReadback,
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
    `Should I? ${actionReadback}`,
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
  // Seen live: the readback said twice in one breath is still that one readback.
  assert.isTrue(
    makeVoiceConfirmationGate().claim(
      claimAction(
        timed(say(["assistant", `${actionReadback} ${actionReadback}`], ["user", "Yes"])),
      ),
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
  const transcript = timed(
    say(["assistant", "I'll prepare that action."], ["assistant", actionReadback], ["user", "Yes"]),
  );
  for (const target of ["Work", "Audit"])
    assert.isFalse(
      gate.claim({
        ...claimAction(transcript),
        readback: sendReadback(target, actionRequest.detail),
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
  // Seen live: a long separate statement, then the readback on its own.
  assert.isTrue(
    makeVoiceConfirmationGate().claim(
      claimAction(
        timed(
          say(
            [
              "assistant",
              "Let me check that main thread real quick. Sure, I'll prepare that for you.",
            ],
            ["assistant", actionReadback],
            ["user", "Yes That is right"],
            ["user", "Send it"],
          ),
        ),
      ),
    ),
  );
  for (const prefix of [
    "Do not",
    "I'll prepare that action but do not approve",
    "Also delete the project",
    "Should I hold off?",
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
  // A short, plain lead-in in the same breath is fine; a redirect in it is not.
  assert.isTrue(
    makeVoiceConfirmationGate().claim(
      claimAction(
        timed(say(["assistant", `I'll prepare that action. ${actionReadback}`], ["user", "Yes"])),
      ),
    ),
  );
  assert.isFalse(
    makeVoiceConfirmationGate().claim(
      claimAction(
        timed(
          say(["assistant", `I'll prepare it but not yet. ${actionReadback}`], ["user", "Yes"]),
        ),
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
  const otherWording = timed(
    say(
      ["assistant", "Looking now."],
      ["assistant", actionReadback],
      ["user", "Yes, I approve this action."],
      ["assistant", "Okay. Approving now. Thanks. I’ll submit that."],
    ),
  );
  assert.isTrue(makeVoiceConfirmationGate().claim(claimAction(otherWording)));
  const withNewDraft = timed(
    say(
      ["assistant", actionReadback],
      ["user", "Yes, I approve this action"],
      ["assistant", "Actually, should I also delete the old audit thread first?"],
    ),
  );
  assert.isFalse(makeVoiceConfirmationGate().claim(claimAction(withNewDraft)));
  // A short question takes the next yes too (CodeRabbit, PR #11).
  const withShortQuestion = timed(
    say(
      ["assistant", actionReadback],
      ["assistant", "Also delete the old thread?"],
      ["user", "Yes"],
    ),
  );
  assert.isFalse(makeVoiceConfirmationGate().claim(claimAction(withShortQuestion)));
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
    assert.isTrue(
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
