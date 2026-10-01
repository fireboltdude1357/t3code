import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestratorMcpThreadStatus } from "./orchestratorMcp.ts";
import { OrchestrationV2UserInputQuestion } from "./orchestrationV2.ts";
import { VoiceAgendaItem, VoiceConfirmRequest, VoiceNotice } from "./voiceSession.ts";

/**
 * Inputs and results of the `voice_*` MCP tools. Only a live voice session
 * thread may call them; they read and act across every project.
 */

/** MCP structuredContent must contain JSON values rather than DateTime instances. */
export const VoiceMcpConfirmRequest = VoiceConfirmRequest.mapFields((fields) => ({
  ...fields,
  expiresAt: IsoDateTime,
}));
export type VoiceMcpConfirmRequest = typeof VoiceMcpConfirmRequest.Type;

export const VoiceMcpThreadsInput = Schema.Struct({
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type VoiceMcpThreadsInput = typeof VoiceMcpThreadsInput.Type;

export const VoiceMcpThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  projectTitle: Schema.String,
  title: Schema.String,
  status: OrchestratorMcpThreadStatus,
  /** True while the thread waits on an approval or a question. */
  needsInput: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type VoiceMcpThreadSummary = typeof VoiceMcpThreadSummary.Type;

export const VoiceMcpThreadsResult = Schema.Struct({
  threads: Schema.Array(VoiceMcpThreadSummary),
});
export type VoiceMcpThreadsResult = typeof VoiceMcpThreadsResult.Type;

export const VoiceMcpThreadReadInput = Schema.Struct({
  threadId: ThreadId,
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
});
export type VoiceMcpThreadReadInput = typeof VoiceMcpThreadReadInput.Type;

export const VoiceMcpMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  truncated: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type VoiceMcpMessage = typeof VoiceMcpMessage.Type;

export const VoiceMcpThreadReadResult = Schema.Struct({
  thread: VoiceMcpThreadSummary,
  /** Oldest first. */
  messages: Schema.Array(VoiceMcpMessage),
});
export type VoiceMcpThreadReadResult = typeof VoiceMcpThreadReadResult.Type;

export const VoiceMcpQuestionListInput = Schema.Struct({ threadId: ThreadId });
export type VoiceMcpQuestionListInput = typeof VoiceMcpQuestionListInput.Type;

export const VoiceMcpQuestionListResult = Schema.Struct({
  threadId: ThreadId,
  requestIds: Schema.Array(RuntimeRequestId),
});
export type VoiceMcpQuestionListResult = typeof VoiceMcpQuestionListResult.Type;

export const VoiceMcpQuestionReadInput = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
});
export type VoiceMcpQuestionReadInput = typeof VoiceMcpQuestionReadInput.Type;

export const VoiceMcpQuestionReadResult = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  questions: Schema.Array(OrchestrationV2UserInputQuestion),
});
export type VoiceMcpQuestionReadResult = typeof VoiceMcpQuestionReadResult.Type;

export const VoiceMcpNoticesResult = Schema.toCodecJson(
  Schema.Struct({ notices: Schema.Array(VoiceNotice) }),
);
export type VoiceMcpNoticesResult = typeof VoiceMcpNoticesResult.Type;

export const VoiceMcpAgendaResult = Schema.toCodecJson(
  Schema.Struct({ items: Schema.Array(VoiceAgendaItem) }),
);
export type VoiceMcpAgendaResult = typeof VoiceMcpAgendaResult.Type;

export const VoiceMcpTopicOpenInput = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  detail: Schema.String.check(Schema.isMaxLength(2_000)),
});
export type VoiceMcpTopicOpenInput = typeof VoiceMcpTopicOpenInput.Type;

export const VoiceMcpTopicOpenResult = Schema.toCodecJson(Schema.Struct({ item: VoiceAgendaItem }));
export type VoiceMcpTopicOpenResult = typeof VoiceMcpTopicOpenResult.Type;

export const VoiceMcpTopicCloseInput = Schema.Struct({ id: TrimmedNonEmptyString });
export type VoiceMcpTopicCloseInput = typeof VoiceMcpTopicCloseInput.Type;

export const VoiceMcpTopicCloseResult = Schema.Struct({
  /** False when the item does not exist or was already closed. */
  closed: Schema.Boolean,
});
export type VoiceMcpTopicCloseResult = typeof VoiceMcpTopicCloseResult.Type;

export const VoiceMcpSendInput = Schema.Struct({
  threadId: ThreadId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  mode: Schema.optional(Schema.Literals(["auto", "queue"])),
});
export type VoiceMcpSendInput = typeof VoiceMcpSendInput.Type;

export const VoiceMcpSendResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("sent"),
    threadId: ThreadId,
    runId: RunId,
    delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  }),
  Schema.Struct({
    /** Nothing was sent; `instruction` says what to do first. */
    status: Schema.Literal("needs_spoken_yes"),
    instruction: Schema.String,
  }),
]);
export type VoiceMcpSendResult = typeof VoiceMcpSendResult.Type;

export const VoiceMcpLaunchInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
});
export type VoiceMcpLaunchInput = typeof VoiceMcpLaunchInput.Type;

export const VoiceMcpLaunchResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("launched"),
    threadId: ThreadId,
    runId: Schema.NullOr(RunId),
  }),
  Schema.Struct({ status: Schema.Literal("denied") }),
  Schema.Struct({
    status: Schema.Literal("needs_approval"),
    request: VoiceMcpConfirmRequest,
    readback: Schema.String,
  }),
]);
export type VoiceMcpLaunchResult = typeof VoiceMcpLaunchResult.Type;

export const VoiceMcpInterruptInput = Schema.Struct({ threadId: ThreadId });
export type VoiceMcpInterruptInput = typeof VoiceMcpInterruptInput.Type;

export const VoiceMcpInterruptResult = Schema.Union([
  Schema.Struct({
    threadId: ThreadId,
    status: Schema.Literals(["interrupt_requested", "no_active_run", "already_terminal", "denied"]),
  }),
  Schema.Struct({
    status: Schema.Literal("needs_approval"),
    threadId: ThreadId,
    request: VoiceMcpConfirmRequest,
    readback: Schema.String,
  }),
]);
export type VoiceMcpInterruptResult = typeof VoiceMcpInterruptResult.Type;

export const VoiceMcpConfirmationsResult = Schema.Struct({
  requests: Schema.Array(
    Schema.Struct({ request: VoiceMcpConfirmRequest, readback: Schema.String }),
  ),
});
export type VoiceMcpConfirmationsResult = typeof VoiceMcpConfirmationsResult.Type;

export const VoiceMcpApproveInput = Schema.Struct({ requestId: TrimmedNonEmptyString });
export type VoiceMcpApproveInput = typeof VoiceMcpApproveInput.Type;

export const VoiceMcpApproveResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("failed"), requestId: TrimmedNonEmptyString }),
  Schema.Struct({
    status: Schema.Literal("approved"),
    requestId: TrimmedNonEmptyString,
    completion: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("unavailable"), requestId: TrimmedNonEmptyString }),
  Schema.Struct({
    status: Schema.Literal("needs_spoken_yes"),
    requestId: TrimmedNonEmptyString,
    instruction: Schema.String,
  }),
]);
export type VoiceMcpApproveResult = typeof VoiceMcpApproveResult.Type;
