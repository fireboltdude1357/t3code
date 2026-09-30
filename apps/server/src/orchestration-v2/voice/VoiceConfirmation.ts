import type { VoiceTranscriptEntry } from "./VoiceStore.ts";

const MIN_READ_BACK_RECALL = 0.8;

const AFFIRMATIVES = [
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "correct",
  "ok",
  "okay",
  "perfect",
  "confirm",
  "confirmed",
  "send it",
  "go ahead",
  "do it",
  "sounds good",
  "please do",
  "thats right",
  "ship it",
];

// Any of these in the reply means the user is not simply saying yes.
const OBJECTIONS = [
  "no",
  "nope",
  "dont",
  "do not",
  "not yet",
  "wait",
  "hold on",
  "hang on",
  "change",
  "actually",
  "but",
  "instead",
  "cancel",
  "stop",
];

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

const hasPhrase = (padded: string, phrase: string) => padded.includes(` ${phrase} `);

/** Share of the draft's words (counting repeats) that appear in the read-back. */
function recall(draft: ReadonlyArray<string>, readBack: ReadonlyArray<string>): number {
  const available = new Map<string, number>();
  for (const word of readBack) available.set(word, (available.get(word) ?? 0) + 1);
  let matched = 0;
  for (const word of draft) {
    const count = available.get(word) ?? 0;
    if (count > 0) {
      matched++;
      available.set(word, count - 1);
    }
  }
  return matched / draft.length;
}

function isAffirmative(reply: string): boolean {
  const padded = ` ${words(reply).join(" ")} `;
  return (
    AFFIRMATIVES.some((phrase) => hasPhrase(padded, phrase)) &&
    !OBJECTIONS.some((phrase) => hasPhrase(padded, phrase))
  );
}

/**
 * The code-owned spoken-yes gate for voice sends. True only when the
 * assistant's latest read-back contains the draft closely enough and the
 * user's reply after it is a plain yes.
 *
 * The read-back is the last run of consecutive assistant entries that the
 * user answered. A trailing assistant run with no reply yet is skipped when it
 * is an acknowledgement ("Sending it now." spoken alongside the tool call),
 * but a trailing read-back of the draft fails the gate. The reply is
 * every user entry after the read-back, joined, so "Yes. Wait, change it"
 * split across parts is still an objection.
 */
export function isSpokenConfirmation(
  transcript: ReadonlyArray<VoiceTranscriptEntry>,
  draft: string,
): boolean {
  const draftWords = words(draft);
  if (draftWords.length === 0) return false;

  const readsBack = (entries: ReadonlyArray<VoiceTranscriptEntry>) =>
    recall(draftWords, words(entries.map((entry) => entry.text).join(" "))) >= MIN_READ_BACK_RECALL;

  let end = transcript.length;
  while (end > 0 && transcript[end - 1]?.role === "assistant") end--;
  // An unanswered read-back of this draft means the user has not replied yet.
  if (end < transcript.length && readsBack(transcript.slice(end))) return false;
  let replyStart = end;
  while (replyStart > 0 && transcript[replyStart - 1]?.role === "user") replyStart--;
  let readBackStart = replyStart;
  while (readBackStart > 0 && transcript[readBackStart - 1]?.role === "assistant") readBackStart--;
  if (readBackStart === replyStart || replyStart === end) return false;

  const reply = transcript.slice(replyStart, end).map((entry) => entry.text);
  return readsBack(transcript.slice(readBackStart, replyStart)) && isAffirmative(reply.join(" "));
}
