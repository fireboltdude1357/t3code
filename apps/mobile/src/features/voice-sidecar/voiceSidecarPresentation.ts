import type {
  LunaDictionaryEntry,
  LunaMessage,
  LunaServiceStatus,
  LunaSession,
} from "./lunaHostApi";

export function latestCompleteAssistantMessage(
  messages: ReadonlyArray<LunaMessage>,
): LunaMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.status === "complete") return message;
  }
  return null;
}

export function dictionaryEntryLabel(entry: LunaDictionaryEntry): string {
  return entry.kind === "term" ? entry.phrase : `${entry.phrase} → ${entry.replacement ?? ""}`;
}

export function serviceStatusLabel(status: LunaServiceStatus): string {
  return status === "ready" ? "Ready" : "Not configured";
}

export function sentenceCountLabel(count: 1 | 2 | 3): string {
  return `${count} sentence${count === 1 ? "" : "s"}`;
}

export type HandsfreePhase =
  | "unavailable"
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "preparing-voice"
  | "speaking"
  | "paused";

/**
 * Collapses recorder, host, speech, and player state into the one phase the
 * handsfree screen shows and taps against. Earlier entries win because they
 * describe what the device is doing right now.
 */
export function resolveHandsfreePhase(input: {
  readonly transcriptionReady: boolean;
  readonly recorderPhase: "idle" | "preparing" | "recording" | "submitting" | "error";
  readonly asking: boolean;
  readonly sessionStatus: LunaSession["status"];
  readonly speechStatus: "idle" | "loading" | "ready" | "error" | undefined;
  readonly playing: boolean;
  readonly pausedMidway: boolean;
}): HandsfreePhase {
  if (!input.transcriptionReady) return "unavailable";
  if (input.recorderPhase === "preparing" || input.recorderPhase === "recording")
    return "listening";
  if (input.recorderPhase === "submitting" || input.asking) return "transcribing";
  if (input.sessionStatus === "waiting-for-luna") return "thinking";
  if (input.speechStatus === "loading") return "preparing-voice";
  if (input.playing) return "speaking";
  if (input.pausedMidway) return "paused";
  return "idle";
}

export type HandsfreeTapAction = "record" | "send" | "pause" | "none";

export function handsfreeTapAction(phase: HandsfreePhase): HandsfreeTapAction {
  switch (phase) {
    case "idle":
    case "paused":
      return "record";
    case "listening":
      return "send";
    case "speaking":
      return "pause";
    default:
      return "none";
  }
}

export function handsfreeStatus(
  phase: HandsfreePhase,
  elapsedSeconds: number,
): { readonly title: string; readonly hint: string | null } {
  switch (phase) {
    case "unavailable":
      return {
        title: "Voice unavailable",
        hint: "Add an OpenAI API key in Settings → Voice & Luna.",
      };
    case "idle":
      return { title: "Tap to talk", hint: "Tap again to send." };
    case "listening":
      return { title: "Listening", hint: `${formatClock(elapsedSeconds)} · Tap to send.` };
    case "transcribing":
      return { title: "Transcribing", hint: null };
    case "thinking":
      return { title: "Luna is thinking", hint: null };
    case "preparing-voice":
      return { title: "Preparing Luna's voice", hint: null };
    case "speaking":
      return { title: "Luna is speaking", hint: "Tap to pause." };
    case "paused":
      return { title: "Paused", hint: "Tap to talk, or resume below." };
  }
}

export function formatClock(totalSeconds: number): string {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
