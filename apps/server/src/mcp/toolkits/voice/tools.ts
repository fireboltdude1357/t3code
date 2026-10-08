import {
  OrchestratorMcpFailure,
  VoiceMcpAgendaResult,
  VoiceMcpApproveInput,
  VoiceMcpApproveResult,
  VoiceMcpConfirmationsResult,
  VoiceMcpInterruptInput,
  VoiceMcpInterruptResult,
  VoiceMcpLaunchInput,
  VoiceMcpLaunchResult,
  VoiceMcpNoticesResult,
  VoiceMcpQuestionListInput,
  VoiceMcpQuestionListResult,
  VoiceMcpQuestionReadInput,
  VoiceMcpQuestionReadResult,
  VoiceMcpSendInput,
  VoiceMcpSendResult,
  VoiceMcpThreadReadInput,
  VoiceMcpThreadReadResult,
  VoiceMcpThreadsInput,
  VoiceMcpThreadsResult,
  VoiceMcpTopicCloseInput,
  VoiceMcpTopicCloseResult,
  VoiceMcpTopicOpenInput,
  VoiceMcpTopicOpenResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * Tools for the voice orchestrator's session thread. They read and act across
 * every project, so each handler refuses any caller that is not a live voice
 * session thread. Write tools hold until the user says yes.
 */
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, Crypto.Crypto],
};

const VoiceThreadsTool = Tool.make("voice_threads", {
  ...shared,
  description:
    "List the user's threads across all projects, newest first, with status and whether each needs input.",
  parameters: VoiceMcpThreadsInput,
  success: VoiceMcpThreadsResult,
})
  .annotate(Tool.Title, "List all threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const VoiceThreadReadTool = Tool.make("voice_thread_read", {
  ...shared,
  description:
    "Read the last messages (default 10) of any thread, plus its status. Long messages are trimmed.",
  parameters: VoiceMcpThreadReadInput,
  success: VoiceMcpThreadReadResult,
})
  .annotate(Tool.Title, "Read a thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const VoiceQuestionListTool = Tool.make("voice_pending_question_list", {
  ...shared,
  description:
    "List pending user-question IDs in any thread from a live voice session. Permission approvals are excluded. Use voice_pending_question_read to read each question.",
  parameters: VoiceMcpQuestionListInput,
  success: VoiceMcpQuestionListResult,
})
  .annotate(Tool.Title, "List pending questions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const VoiceQuestionReadTool = Tool.make("voice_pending_question_read", {
  ...shared,
  description:
    "Read a pending user question and its options in any thread from a live voice session. Resolved questions and permission approvals cannot be read here. This tool does not answer questions or approve permissions.",
  parameters: VoiceMcpQuestionReadInput,
  success: VoiceMcpQuestionReadResult,
})
  .annotate(Tool.Title, "Read a pending question")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const VoicePendingNoticesTool = Tool.make("voice_pending_notices", {
  ...shared,
  description:
    "Get thread updates the user has not been told yet, oldest first. They count as delivered once returned, so tell the user.",
  success: VoiceMcpNoticesResult,
})
  .annotate(Tool.Title, "Get pending notices")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const VoiceAgendaListTool = Tool.make("voice_agenda_list", {
  ...shared,
  description: "List open agenda items: threads to follow up on and topics to come back to.",
  success: VoiceMcpAgendaResult,
})
  .annotate(Tool.Title, "List the agenda")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const VoiceTopicOpenTool = Tool.make("voice_topic_open", {
  ...shared,
  description: "Add a topic to the agenda, for example when the user says to remind them later.",
  parameters: VoiceMcpTopicOpenInput,
  success: VoiceMcpTopicOpenResult,
})
  .annotate(Tool.Title, "Open an agenda topic")
  .annotate(Tool.Destructive, false);

const VoiceTopicCloseTool = Tool.make("voice_topic_close", {
  ...shared,
  description: "Close an agenda item by id once it is dealt with.",
  parameters: VoiceMcpTopicCloseInput,
  success: VoiceMcpTopicCloseResult,
})
  .annotate(Tool.Title, "Close an agenda item")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const VoiceSendTool = Tool.make("voice_send", {
  ...shared,
  description:
    "Send a message to a thread. First read the exact text back to the user word for word and wait for their spoken yes; without it nothing is sent and you get status needs_spoken_yes.",
  parameters: VoiceMcpSendInput,
  success: VoiceMcpSendResult,
})
  .annotate(Tool.Title, "Send to a thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const VoiceLaunchTool = Tool.make("voice_launch", {
  ...shared,
  description:
    "Start a new thread in a project's root checkout with a first message. The thread runs Claude Opus 5.5 on high with full access. Returns needs_approval with a requestId and exact readback. Read it word for word, wait for a fresh spoken yes, then call voice_approve. The user can also tap Approve on the phone.",
  parameters: VoiceMcpLaunchInput,
  success: VoiceMcpLaunchResult,
})
  .annotate(Tool.Title, "Start a new thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const VoiceInterruptTool = Tool.make("voice_interrupt", {
  ...shared,
  description:
    "Stop a thread's running turn. Returns needs_approval with a requestId and exact readback. Read it word for word, wait for a fresh spoken yes, then call voice_approve. The user can also tap Approve on the phone.",
  parameters: VoiceMcpInterruptInput,
  success: VoiceMcpInterruptResult,
})
  .annotate(Tool.Title, "Stop a thread")
  .annotate(Tool.Destructive, true);

const VoiceConfirmationsTool = Tool.make("voice_confirmations", {
  ...shared,
  description:
    "Get pending action approvals and their exact readbacks. Read one readback word for word, wait for a fresh spoken yes, then call voice_approve with that requestId. Taps remain available.",
  success: VoiceMcpConfirmationsResult,
})
  .annotate(Tool.Title, "Get pending voice approvals")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const VoiceApproveTool = Tool.make("voice_approve", {
  ...shared,
  description:
    "Approve one pending action by requestId after its exact readback and a fresh spoken yes. The server validates the current call transcript, action identity and expiry. This resolves the same approval as a phone tap.",
  parameters: VoiceMcpApproveInput,
  success: VoiceMcpApproveResult,
})
  .annotate(Tool.Title, "Approve a voice action")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const VoiceToolkit = Toolkit.make(
  VoiceThreadsTool,
  VoiceThreadReadTool,
  VoiceQuestionListTool,
  VoiceQuestionReadTool,
  VoicePendingNoticesTool,
  VoiceAgendaListTool,
  VoiceTopicOpenTool,
  VoiceTopicCloseTool,
  VoiceSendTool,
  VoiceLaunchTool,
  VoiceInterruptTool,
  VoiceConfirmationsTool,
  VoiceApproveTool,
);
