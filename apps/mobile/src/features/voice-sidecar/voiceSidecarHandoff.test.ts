import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  buildVoiceSidecarHandoffMessage,
  resolveCompletedAssistantSourceText,
  resolveVoiceSidecarHandoffText,
} from "./voiceSidecarHandoff";

const snapshot = {
  session: {
    messages: [
      {
        id: "assistant-complete",
        role: "assistant",
        status: "complete",
        text: "  Send this answer.  ",
      },
      {
        id: "assistant-streaming",
        role: "assistant",
        status: "streaming",
        text: "Not ready",
      },
      {
        id: "user-complete",
        role: "user",
        status: "complete",
        text: "Not an assistant answer",
      },
    ],
  },
} as const;

describe("voice sidecar handoff", () => {
  it("keeps the exact completed source response text", () => {
    const messages = [
      {
        id: MessageId.make("completed"),
        role: "assistant",
        streaming: false,
        text: "  Exact response with its whitespace.\n",
      },
      {
        id: MessageId.make("streaming"),
        role: "assistant",
        streaming: true,
        text: "Not finished",
      },
    ] as const;

    expect(resolveCompletedAssistantSourceText(messages, MessageId.make("completed"))).toBe(
      "  Exact response with its whitespace.\n",
    );
    expect(resolveCompletedAssistantSourceText(messages, MessageId.make("streaming"))).toBeNull();
    expect(resolveCompletedAssistantSourceText(messages, MessageId.make("missing"))).toBeNull();
  });

  it("resolves authored text and completed assistant messages", () => {
    expect(resolveVoiceSidecarHandoffText({ _tag: "text", text: "  My reply  " }, snapshot)).toBe(
      "  My reply  ",
    );
    expect(
      resolveVoiceSidecarHandoffText(
        { _tag: "assistant-message", messageId: "assistant-complete" },
        snapshot,
      ),
    ).toBe("  Send this answer.  ");
  });

  it("rejects missing, unfinished, and non-assistant messages", () => {
    for (const messageId of ["missing", "assistant-streaming", "user-complete"]) {
      expect(() =>
        resolveVoiceSidecarHandoffText({ _tag: "assistant-message", messageId }, snapshot),
      ).toThrow("no longer available");
    }
  });

  it("builds an outbox message for the source thread with its current settings", () => {
    const message = buildVoiceSidecarHandoffMessage({
      environmentId: EnvironmentId.make("source-environment"),
      threadId: ThreadId.make("source-thread"),
      text: "Send this answer.",
      thread: {
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      metadata: {
        commandId: "command-1",
        messageId: "message-1",
        createdAt: "2026-08-31T12:00:00.000Z",
      },
    });

    expect(message).toEqual({
      environmentId: EnvironmentId.make("source-environment"),
      threadId: ThreadId.make("source-thread"),
      messageId: "message-1",
      commandId: "command-1",
      text: "Send this answer.",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-08-31T12:00:00.000Z",
    });
  });
});
