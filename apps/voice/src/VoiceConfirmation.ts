import type { VoiceConfirmRequest } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { VoiceTranscriptEntry } from "./VoiceStore.ts";

/** A yes is a short reply; anything longer is a conversation, not a confirmation. */
const MAX_REPLY_WORDS = 10;

/** Only these separate preparation entries may precede an exact readback. */
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

/**
 * Words that change what a short earlier entry means ("Do not.", "Also delete
 * the project."). Such an entry is never skipped before a readback.
 */
const REDIRECT_WORDS = new Set([
  "no",
  "not",
  "dont",
  "never",
  "cancel",
  "stop",
  "delete",
  "remove",
  "also",
  "but",
  "instead",
  "except",
  "wait",
  "actually",
  "and",
  "wont",
  "cant",
  "cannot",
  "shouldnt",
  "wouldnt",
  "isnt",
  "doesnt",
  "unless",
  "until",
  "if",
  "only",
  "without",
]);

/** A question asks the user something new, so it can't be skipped or talked through. */
const asksQuestion = (text: string) => /[?？]/.test(text);

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
 * The code-owned spoken-yes gate. True only when the latest run of assistant
 * entries is exactly `readback` (ignoring case and punctuation, after skipping
 * whole harmless filler entries before it), and everything the user said after
 * it is a short, plain yes.
 *
 * The voice model often talks over the yes ("Okay, sending that"), so
 * assistant statements after the readback are allowed. Any assistant
 * question ends the window, since the user's next words may answer it.
 * A readback the user hasn't answered yet fails.
 */
/** Longest statement that may lead into a readback in the same breath. */
const MAX_INLINE_PREFIX_WORDS = 10;

const questionCount = (text: string) => text.match(/[?？]/g)?.length ?? 0;

/**
 * Whether `run` is the readback, said once or more ("...Should I send it?
 * Send to ...Should I send it?"), optionally after a short lead-in in the same
 * breath ("Sure, I'll prepare it for the main thread."). GPT-Live does both
 * live. The lead-in may not ask anything or carry a redirecting word, so
 * nothing but the readback can be what the user's yes answers.
 */
function isReadbackRun(run: string, readback: string): boolean {
  const said = words(run);
  const wanted = words(readback);
  let end = said.length;
  let copies = 0;
  while (
    end >= wanted.length &&
    wanted.every((word, i) => said[end - wanted.length + i] === word)
  ) {
    end -= wanted.length;
    copies++;
  }
  if (copies === 0) return false;
  const leadIn = said.slice(0, end);
  return (
    leadIn.length <= MAX_INLINE_PREFIX_WORDS &&
    !leadIn.some((word) => REDIRECT_WORDS.has(word)) &&
    questionCount(run) === copies * questionCount(readback)
  );
}

function confirmationEvidence(
  transcript: ReadonlyArray<VoiceTranscriptEntry>,
  readback: string,
):
  | {
      readonly readBack: VoiceTranscriptEntry;
      readonly readBackStart: VoiceTranscriptEntry;
      readonly replies: ReadonlyArray<VoiceTranscriptEntry>;
    }
  | undefined {
  const wanted = words(readback).join(" ");
  if (wanted === "") return undefined;

  // A readback can arrive split across consecutive assistant entries, so
  // each run of them is checked as one. The latest matching run wins.
  let readBackEnd = -1;
  let readBackStart = -1;
  for (let end = transcript.length - 1; end >= 0 && readBackEnd === -1; end--) {
    if (transcript[end]?.role !== "assistant") continue;
    let start = end;
    while (start > 0 && transcript[start - 1]?.role === "assistant") start--;
    // An exact run (after skipped separate filler entries) wins; only when there
    // is none may the readback come after a lead-in in the same breath.
    for (const lenient of [false, true]) {
      for (let candidateStart = start; candidateStart <= end; candidateStart++) {
        const run = transcript
          .slice(candidateStart, end + 1)
          .map((entry) => entry.text)
          .join(" ");
        if (lenient ? isReadbackRun(run, readback) : words(run).join(" ") === wanted) {
          readBackEnd = end;
          readBackStart = candidateStart;
          break;
        }
        // Keep entry boundaries: only whole earlier entries are skipped: known
        // preparation phrases, or statements ("Let me check that main thread real
        // quick.") with no question and no redirecting word. Only the readback is
        // executed, and the user still answers it, so it must be the rest of the run.
        const earlierText = transcript[candidateStart]!.text;
        const earlier = words(earlierText);
        const isFiller =
          !asksQuestion(earlierText) && !earlier.some((word) => REDIRECT_WORDS.has(word));
        if (!(PRE_READBACK_ACKS.has(earlier.join(" ")) || isFiller)) break;
      }
      if (readBackEnd !== -1) break;
    }
    end = start;
  }
  if (readBackEnd === -1) return undefined;

  const reply: VoiceTranscriptEntry[] = [];
  for (const entry of transcript.slice(readBackEnd + 1)) {
    if (entry.role === "user") {
      reply.push(entry);
      continue;
    }
    // The voice model talks while it hands off ("Okay. Approving now. Thanks.
    // I'll submit that."). Any question ends the window, however short: the
    // user's later words might answer it rather than the readback.
    if (asksQuestion(entry.text)) return undefined;
  }
  return isAffirmative(reply.map((entry) => entry.text).join(" "))
    ? {
        readBack: transcript[readBackEnd]!,
        readBackStart: transcript[readBackStart]!,
        replies: reply,
      }
    : undefined;
}

/**
 * The exact text the voice model must speak before a send. Code owns it, so a
 * yes covers this draft and this thread and nothing else.
 */
export function sendReadback(targetTitle: string, draft: string): string {
  const body = draft.trim();
  return `Send to ${targetTitle.trim()}: ${/[.!?？]$/.test(body) ? body : `${body}.`} Should I send it?`;
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
      /** The exact readback the user must have answered. */
      readonly readback: string;
      readonly notBefore?: DateTime.Utc;
    }): boolean {
      const now = DateTime.toEpochMillis(input.now);
      const oldest = now - 120_000;
      for (const [key, at] of used) if (at < oldest) used.delete(key);
      const transcript = input.transcript.filter((entry) => entry.generation === input.generation);
      const evidence = confirmationEvidence(transcript, input.readback);
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
