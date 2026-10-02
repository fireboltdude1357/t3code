import type { VoiceConfirmRequest } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { VoiceTranscriptEntry } from "./VoiceStore.ts";

/** The read-back must also name the target thread, so a yes can't be redirected. */
const MIN_TITLE_RECALL = 0.5;
/** A yes is a short reply; anything longer is a conversation, not a confirmation. */
const MAX_REPLY_WORDS = 10;
/** Assistant entries after the read-back up to this long are acknowledgements. */
const MAX_ACK_WORDS = 6;

/** Only these separate preparation entries may precede an exact action readback. */
const PRE_READBACK_ACKS = new Set(
  [
    "I'll prepare that action",
    "Okay",
    "All right",
    "Sure",
    "One moment",
    "I'll check that",
    "Let me check that",
    "Let me get that ready",
    "Let me check on that",
    "Just a sec",
    "One sec",
    "Checking",
    "Let me pull that together",
  ].map((text) => words(text).join(" ")),
);

/** Words that carry the yes. A reply needs at least one. */
const YES_WORDS = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "correct",
  "approve",
  "confirm",
  "confirmed",
  "send",
  "go",
  "do",
  "ship",
  "perfect",
  "sounds",
]);
/**
 * Every word of the reply must come from here, so "not sure", "I can't
 * confirm" or "maybe yes tomorrow" never count: they contain a word outside it.
 */
const REPLY_VOCABULARY = new Set([
  ...YES_WORDS,
  "i",
  "this",
  "action",
  "it",
  "is",
  "ahead",
  "please",
  "that",
  "thats",
  "right",
  "good",
  "thanks",
  "thank",
  "you",
  "great",
]);

/** Lowercase words with punctuation and apostrophes removed ("Don't!" -> "dont"). */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "");
}

/** Share of `wanted` words (counting repeats) found anywhere in `text`. */
function recall(wanted: ReadonlyArray<string>, text: ReadonlyArray<string>): number {
  const available = new Map<string, number>();
  for (const word of text) available.set(word, (available.get(word) ?? 0) + 1);
  let matched = 0;
  for (const word of wanted) {
    const count = available.get(word) ?? 0;
    if (count > 0) {
      matched++;
      available.set(word, count - 1);
    }
  }
  return matched / wanted.length;
}

/** Whether `needle` appears in `haystack` as one unbroken run of words. */
function containsRun(haystack: ReadonlyArray<string>, needle: ReadonlyArray<string>): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

function isAffirmative(reply: string): boolean {
  const replyWords = words(reply);
  return (
    replyWords.length > 0 &&
    replyWords.length <= MAX_REPLY_WORDS &&
    replyWords.every((word) => REPLY_VOCABULARY.has(word)) &&
    replyWords.some((word) => YES_WORDS.has(word))
  );
}

/**
 * The code-owned spoken-yes gate for voice sends. True only when an
 * assistant entry reads back the whole draft, word for word and in order
 * (and names `targetTitle` when given), and everything the user said after
 * it is a short, plain yes.
 *
 * The voice model often talks over the yes ("Okay, sending that"), so
 * assistant entries after the read-back are allowed when they are short
 * acknowledgements. A longer one ends the window: it may be a new draft.
 * A read-back the user hasn't answered yet fails.
 */
function confirmationEvidence(
  transcript: ReadonlyArray<VoiceTranscriptEntry>,
  draft: string,
  targetTitle?: string,
  exactReadback = false,
):
  | {
      readonly readBack: VoiceTranscriptEntry;
      readonly readBackStart: VoiceTranscriptEntry;
      readonly replies: ReadonlyArray<VoiceTranscriptEntry>;
    }
  | undefined {
  const draftWords = words(draft);
  if (draftWords.length === 0) return undefined;
  const titleWords = targetTitle === undefined ? [] : words(targetTitle);

  // A read-back can arrive split across consecutive assistant entries, so
  // each run of them is checked as one. The latest run with the draft wins.
  let readBackEnd = -1;
  let readBackStart = -1;
  let readBack: string[] = [];
  for (let end = transcript.length - 1; end >= 0 && readBackEnd === -1; end--) {
    if (transcript[end]?.role !== "assistant") continue;
    let start = end;
    while (start > 0 && transcript[start - 1]?.role === "assistant") start--;
    let candidateStart = start;
    while (candidateStart <= end) {
      const run = words(
        transcript
          .slice(candidateStart, end + 1)
          .map((entry) => entry.text)
          .join(" "),
      );
      if (exactReadback ? run.join(" ") === draftWords.join(" ") : containsRun(run, draftWords)) {
        readBackEnd = end;
        readBackStart = candidateStart;
        readBack = run;
        break;
      }
      // Keep entry boundaries: an acknowledgement in the same part as a negation or
      // another action is never removed. Only a whole, known preparation entry is skipped.
      if (
        !exactReadback ||
        !PRE_READBACK_ACKS.has(words(transcript[candidateStart]!.text).join(" "))
      )
        break;
      candidateStart++;
    }
    end = start;
  }
  if (readBackEnd === -1) return undefined;
  if (titleWords.length > 0 && recall(titleWords, readBack) < MIN_TITLE_RECALL) return undefined;

  // An action's readback is not a message-send readback, even when it contains the same draft.
  if (
    !exactReadback &&
    ["Launch a thread", "Interrupt a thread", "Approve a runtime request"].some((prefix) =>
      containsRun(readBack, words(prefix)),
    ) &&
    containsRun(readBack, words("Do you approve this action"))
  )
    return undefined;

  const reply: VoiceTranscriptEntry[] = [];
  for (const entry of transcript.slice(readBackEnd + 1)) {
    if (entry.role === "user") reply.push(entry);
    else if (words(entry.text).length > MAX_ACK_WORDS) return undefined;
  }
  return isAffirmative(reply.map((entry) => entry.text).join(" "))
    ? {
        readBack: transcript[readBackEnd]!,
        readBackStart: transcript[readBackStart]!,
        replies: reply,
      }
    : undefined;
}

export function isSpokenConfirmation(
  transcript: ReadonlyArray<VoiceTranscriptEntry>,
  draft: string,
  targetTitle?: string,
): boolean {
  return confirmationEvidence(transcript, draft, targetTitle) !== undefined;
}

/** The action and its full details must be spoken before a yes can approve it. */
export function confirmationReadback(request: VoiceConfirmRequest): string {
  const action = {
    launch: "Launch a thread",
    interrupt: "Interrupt a thread",
    runtime_approval: "Approve a runtime request",
  }[request.action];
  return `${action}. ${request.title} ${request.detail} Do you approve this action?`;
}

/** Readbacks differing only in punctuation are equally ambiguous when spoken. */
export function sameConfirmationReadback(
  left: VoiceConfirmRequest,
  right: VoiceConfirmRequest,
): boolean {
  return (
    words(confirmationReadback(left)).join(" ") === words(confirmationReadback(right)).join(" ")
  );
}

/** One shared instance per orchestrator, so sends and approvals cannot reuse a yes. */
export function makeVoiceConfirmationGate() {
  const used = new Map<string, number>();
  return {
    claim(input: {
      readonly transcript: ReadonlyArray<VoiceTranscriptEntry>;
      readonly generation: number;
      readonly now: DateTime.Utc;
      readonly draft: string;
      readonly targetTitle?: string;
      readonly notBefore?: DateTime.Utc;
      readonly exactReadback?: boolean;
    }): boolean {
      const now = DateTime.toEpochMillis(input.now);
      const oldest = now - 120_000;
      for (const [key, at] of used) if (at < oldest) used.delete(key);
      const transcript = input.transcript.filter((entry) => entry.generation === input.generation);
      const evidence = confirmationEvidence(
        transcript,
        input.draft,
        input.targetTitle,
        input.exactReadback,
      );
      if (evidence === undefined) return false;
      const readBackAt = DateTime.toEpochMillis(evidence.readBack.at);
      if (
        readBackAt < oldest ||
        readBackAt > now ||
        (input.notBefore !== undefined &&
          DateTime.toEpochMillis(evidence.readBackStart.at) <
            DateTime.toEpochMillis(input.notBefore))
      )
        return false;
      const keys = evidence.replies.map((entry) => ({
        key: `${entry.generation}:${DateTime.toEpochMillis(entry.at)}:${entry.text}`,
        at: DateTime.toEpochMillis(entry.at),
      }));
      if (keys.some(({ key, at }) => used.has(key) || at < readBackAt || at < oldest || at > now))
        return false;
      // Claim every part, including the first yes, so appending another yes cannot revive it.
      for (const { key, at } of keys) used.set(key, at);
      return true;
    },
  };
}
