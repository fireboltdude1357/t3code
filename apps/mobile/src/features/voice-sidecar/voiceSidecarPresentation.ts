import type { LunaDictionaryEntry, LunaMessage, LunaServiceStatus } from "./lunaHostApi";

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
