import type { VoiceTranscriptEntry } from "./VoiceStore.ts";

/** The read-back must also name the target thread, so a yes can't be redirected. */
const MIN_TITLE_RECALL = 0.5;
/** A yes is a short reply; anything longer is a conversation, not a confirmation. */
const MAX_REPLY_WORDS = 10;
/** Assistant entries after the read-back up to this long are acknowledgements. */
const MAX_ACK_WORDS = 6;

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
export function isSpokenConfirmation(
  transcript: ReadonlyArray<VoiceTranscriptEntry>,
  draft: string,
  targetTitle?: string,
): boolean {
  const draftWords = words(draft);
  if (draftWords.length === 0) return false;
  const titleWords = targetTitle === undefined ? [] : words(targetTitle);

  // A read-back can arrive split across consecutive assistant entries, so
  // each run of them is checked as one. The latest run with the draft wins.
  let readBackEnd = -1;
  let readBack: string[] = [];
  for (let end = transcript.length - 1; end >= 0 && readBackEnd === -1; end--) {
    if (transcript[end]?.role !== "assistant") continue;
    let start = end;
    while (start > 0 && transcript[start - 1]?.role === "assistant") start--;
    const run = words(
      transcript
        .slice(start, end + 1)
        .map((entry) => entry.text)
        .join(" "),
    );
    if (containsRun(run, draftWords)) {
      readBackEnd = end;
      readBack = run;
    }
    end = start;
  }
  if (readBackEnd === -1) return false;
  if (titleWords.length > 0 && recall(titleWords, readBack) < MIN_TITLE_RECALL) return false;

  const reply: string[] = [];
  for (const entry of transcript.slice(readBackEnd + 1)) {
    if (entry.role === "user") reply.push(entry.text);
    else if (words(entry.text).length > MAX_ACK_WORDS) return false;
  }
  return isAffirmative(reply.join(" "));
}
