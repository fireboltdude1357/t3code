import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";

import type { TurnCommandMetadata } from "../../lib/commandMetadata";
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

export function buildVoiceSidecarHandoffMessage(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly thread: Pick<OrchestrationThread, "modelSelection" | "runtimeMode" | "interactionMode">;
  readonly metadata: Omit<TurnCommandMetadata, "threadId">;
}): QueuedThreadMessage {
  return {
    environmentId: input.environmentId,
    threadId: input.threadId,
    messageId: MessageId.make(input.metadata.messageId),
    commandId: CommandId.make(input.metadata.commandId),
    text: input.text,
    attachments: [],
    modelSelection: input.thread.modelSelection,
    runtimeMode: input.thread.runtimeMode,
    interactionMode: input.thread.interactionMode,
    createdAt: input.metadata.createdAt,
  };
}
