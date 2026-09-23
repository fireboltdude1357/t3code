import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type OrchestrationMessage,
  type ThreadId,
} from "@t3tools/contracts";

import type { TurnCommandMetadata } from "../../lib/commandMetadata";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import type { QueuedThreadMessage } from "../../state/thread-outbox";

/** The reply chosen for the source thread: a Luna answer or user-authored text. */
export type VoiceSidecarHandoffContent =
  | { readonly _tag: "assistant-message"; readonly messageId: string }
  | { readonly _tag: "text"; readonly text: string };

export function resolveCompletedAssistantSourceText(
  messages: ReadonlyArray<Pick<OrchestrationMessage, "id" | "role" | "streaming" | "text">>,
  sourceMessageId: MessageId,
): string | null {
  const source = messages.find((message) => message.id === sourceMessageId);
  return source?.role === "assistant" && !source.streaming && source.text.trim().length > 0
    ? source.text
    : null;
}

/**
 * The reply the composer's Luna button opens on: the newest finished assistant
 * message in the thread feed, or null when there is nothing to talk about yet.
 */
export function resolveLatestLunaSourceMessageId(
  feed: ReadonlyArray<ThreadFeedEntry>,
): MessageId | null {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index];
    if (entry?.type !== "message") continue;
    const { message } = entry;
    if (message.role === "assistant" && !message.streaming && message.text.trim().length > 0) {
      return message.id;
    }
  }
  return null;
}

export interface VoiceSidecarHandoffSnapshot {
  readonly session: {
    readonly messages: ReadonlyArray<{
      readonly id: string;
      readonly role: "user" | "assistant";
      readonly status: string;
      readonly text: string;
    }>;
  };
}

export function resolveVoiceSidecarHandoffText(
  content: VoiceSidecarHandoffContent,
  snapshot: VoiceSidecarHandoffSnapshot,
): string {
  const text =
    content._tag === "text"
      ? content.text
      : snapshot.session.messages.find(
          (message) =>
            message.id === content.messageId &&
            message.role === "assistant" &&
            message.status === "complete",
        )?.text;

  if (text === undefined) {
    throw new Error("That Luna response is no longer available to send.");
  }

  if (text.trim().length === 0) {
    throw new Error("Choose a Luna response or write a reply before sending.");
  }
  return text;
}

/** Leaves model and mode unset so the outbox drain sends with the thread's current settings. */
export function buildVoiceSidecarHandoffMessage(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly metadata: Omit<TurnCommandMetadata, "threadId">;
}): QueuedThreadMessage {
  return {
    environmentId: input.environmentId,
    threadId: input.threadId,
    messageId: MessageId.make(input.metadata.messageId),
    commandId: CommandId.make(input.metadata.commandId),
    text: input.text,
    attachments: [],
    createdAt: input.metadata.createdAt,
  };
}
