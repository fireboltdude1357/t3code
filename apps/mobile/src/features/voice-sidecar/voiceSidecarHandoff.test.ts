import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import {
  buildVoiceSidecarHandoffMessage,
  resolveCompletedAssistantSourceText,
  resolveLatestLunaSourceMessageId,
  resolveVoiceSidecarHandoffText,
} from "./voiceSidecarHandoff";

function feedMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  streaming = false,
): ThreadFeedEntry {
  return {
    type: "message",
    id,
    createdAt: "2026-09-23T12:00:00.000Z",
    message: {
      id: MessageId.make(id),
      role,
      text,
      attachments: [],
      runId: null,
      streaming,
      visibility: "local",
      sourceThreadId: ThreadId.make("thread"),
      createdAt: "2026-09-23T12:00:00.000Z",
      updatedAt: "2026-09-23T12:00:00.000Z",
    },
  };
}

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

  it("builds an outbox message for the source thread that inherits its current settings", () => {
    const message = buildVoiceSidecarHandoffMessage({
      environmentId: EnvironmentId.make("source-environment"),
      threadId: ThreadId.make("source-thread"),
      text: "Send this answer.",
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
      createdAt: "2026-08-31T12:00:00.000Z",
    });
  });

  it("opens the composer's Luna button on the newest finished assistant reply", () => {
    expect(
      resolveLatestLunaSourceMessageId([
        feedMessage("older-answer", "assistant", "Older answer"),
        feedMessage("latest-answer", "assistant", "Latest answer"),
        feedMessage("empty-answer", "assistant", "   "),
        feedMessage("question", "user", "Follow-up question"),
        feedMessage("streaming-answer", "assistant", "Still writ", true),
      ]),
    ).toBe("latest-answer");
    expect(resolveLatestLunaSourceMessageId([feedMessage("question", "user", "Hi")])).toBeNull();
  });
});
