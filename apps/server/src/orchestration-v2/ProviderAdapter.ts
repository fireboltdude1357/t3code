import type { OrchestrationV2HistoricalMessage } from "@t3tools/contracts";
import {
  ChatAttachment,
  CheckpointId,
  MessageId,
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderSession,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderDriverKind,
  ProviderInstanceId,
  PositiveInt,
  ProviderUserInputAnswers,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeMode,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type {
  ProviderSelectionTransitionInput,
  ProviderSelectionTransitionPlan,
} from "./ProviderSelectionTransition.ts";

export const ProviderAdapterV2RuntimePolicy = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  cwd: Schema.NullOr(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
  /** t3-code MCP tools the provider may call without asking. Only Codex honours it. */
  preapprovedT3McpTools: Schema.optional(Schema.Array(Schema.String)),
});
export type ProviderAdapterV2RuntimePolicy = typeof ProviderAdapterV2RuntimePolicy.Type;

export const ProviderAdapterV2TurnMessage = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  createdBy: OrchestrationV2ConversationMessage.fields.createdBy,
  creationSource: OrchestrationV2ConversationMessage.fields.creationSource,
  scheduledTaskId: OrchestrationV2ConversationMessage.fields.scheduledTaskId,
  senderThreadId: OrchestrationV2ConversationMessage.fields.senderThreadId,
});
export type ProviderAdapterV2TurnMessage = typeof ProviderAdapterV2TurnMessage.Type;

export const ProviderAdapterV2SessionStatus = Schema.Literals([
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
]);
export type ProviderAdapterV2SessionStatus = typeof ProviderAdapterV2SessionStatus.Type;

export const ProviderAdapterV2Event = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("app_thread.created"),
    driver: ProviderDriverKind,
    appThread: OrchestrationV2AppThread,
  }),
  Schema.Struct({
    type: Schema.Literal("provider_session.updated"),
    driver: ProviderDriverKind,
    providerSession: OrchestrationV2ProviderSession,
  }),
  Schema.Struct({
    type: Schema.Literal("provider_thread.updated"),
    driver: ProviderDriverKind,
    providerThread: OrchestrationV2ProviderThread,
  }),
  Schema.Struct({
    type: Schema.Literal("provider_turn.updated"),
    driver: ProviderDriverKind,
    threadId: Schema.optional(ThreadId),
    providerTurn: OrchestrationV2ProviderTurn,
  }),
  Schema.Struct({
    type: Schema.Literal("node.updated"),
    driver: ProviderDriverKind,
    node: OrchestrationV2ExecutionNode,
  }),
  Schema.Struct({
    type: Schema.Literal("subagent.updated"),
    driver: ProviderDriverKind,
    subagent: OrchestrationV2Subagent,
  }),
  Schema.Struct({
    type: Schema.Literal("message.updated"),
    driver: ProviderDriverKind,
    message: OrchestrationV2ConversationMessage,
  }),
  Schema.Struct({
    type: Schema.Literal("turn_item.updated"),
    driver: ProviderDriverKind,
    turnItem: OrchestrationV2TurnItem,
  }),
  Schema.Struct({
    type: Schema.Literal("runtime_request.updated"),
    driver: ProviderDriverKind,
    threadId: Schema.optional(ThreadId),
    runtimeRequest: OrchestrationV2RuntimeRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("plan.updated"),
    driver: ProviderDriverKind,
    plan: OrchestrationV2PlanArtifact,
  }),
  Schema.Struct({
    type: Schema.Literal("turn.terminal"),
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    runOrdinal: PositiveInt,
    status: Schema.Literals(["completed", "interrupted", "cancelled"]),
    failure: Schema.Null,
    threadDisposition: Schema.Literals(["reusable", "broken"]),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.terminal"),
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    runOrdinal: PositiveInt,
    failureItemOrdinal: PositiveInt,
    status: Schema.Literal("failed"),
    failure: OrchestrationV2ProviderFailure,
    retry: Schema.optional(OrchestrationV2ProviderRetry),
    retryStartedAt: Schema.optional(Schema.DateTimeUtc),
    threadDisposition: Schema.Literals(["reusable", "broken"]),
  }),
]);
export type ProviderAdapterV2Event = typeof ProviderAdapterV2Event.Type;

export class ProviderAdapterCapabilitiesError extends Schema.TaggedError<ProviderAdapterCapabilitiesError>()(
  "ProviderAdapterCapabilitiesError",
  {
    driver: ProviderDriverKind,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read ${this.driver} provider capabilities.`;
  }
}

export class ProviderAdapterOpenSessionError extends Schema.TaggedError<ProviderAdapterOpenSessionError>()(
  "ProviderAdapterOpenSessionError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to open ${this.driver} provider session ${this.providerSessionId}.`;
  }
}

export class ProviderAdapterCloseSessionError extends Schema.TaggedError<ProviderAdapterCloseSessionError>()(
  "ProviderAdapterCloseSessionError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to close ${this.driver} provider session ${this.providerSessionId}.`;
  }
}

export class ProviderAdapterResumeThreadError extends Schema.TaggedError<ProviderAdapterResumeThreadError>()(
  "ProviderAdapterResumeThreadError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resume ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterEnsureThreadError extends Schema.TaggedError<ProviderAdapterEnsureThreadError>()(
  "ProviderAdapterEnsureThreadError",
  {
    driver: ProviderDriverKind,
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to ensure ${this.driver} provider thread for app thread ${this.threadId}.`;
  }
}

export class ProviderAdapterReadThreadSnapshotError extends Schema.TaggedError<ProviderAdapterReadThreadSnapshotError>()(
  "ProviderAdapterReadThreadSnapshotError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read ${this.driver} provider thread snapshot ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterRollbackThreadError extends Schema.TaggedError<ProviderAdapterRollbackThreadError>()(
  "ProviderAdapterRollbackThreadError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    checkpointId: Schema.optional(CheckpointId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to roll back ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterForkThreadError extends Schema.TaggedError<ProviderAdapterForkThreadError>()(
  "ProviderAdapterForkThreadError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to fork ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterTurnStartError extends Schema.TaggedError<ProviderAdapterTurnStartError>()(
  "ProviderAdapterTurnStartError",
  {
    driver: ProviderDriverKind,
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to start run ${this.runId} on ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterSteerRunUnsupportedError extends Schema.TaggedError<ProviderAdapterSteerRunUnsupportedError>()(
  "ProviderAdapterSteerRunUnsupportedError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
  },
) {
  override get message(): string {
    return `${this.driver} provider thread ${this.providerThreadId} does not support active-run steering.`;
  }
}

export class ProviderAdapterSteerRunError extends Schema.TaggedError<ProviderAdapterSteerRunError>()(
  "ProviderAdapterSteerRunError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to steer active run ${this.providerTurnId} on ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterInterruptError extends Schema.TaggedError<ProviderAdapterInterruptError>()(
  "ProviderAdapterInterruptError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to interrupt ${this.driver} provider turn ${this.providerTurnId}.`;
  }
}

export class ProviderAdapterRuntimeRequestResponseError extends Schema.TaggedError<ProviderAdapterRuntimeRequestResponseError>()(
  "ProviderAdapterRuntimeRequestResponseError",
  {
    driver: ProviderDriverKind,
    requestId: RuntimeRequestId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to respond to ${this.driver} runtime request ${this.requestId}.`;
  }
}

export class ProviderAdapterEventStreamError extends Schema.TaggedError<ProviderAdapterEventStreamError>()(
  "ProviderAdapterEventStreamError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed while streaming ${this.driver} provider session ${this.providerSessionId} events.`;
  }
}

export class ProviderAdapterProtocolError extends Schema.TaggedError<ProviderAdapterProtocolError>()(
  "ProviderAdapterProtocolError",
  {
    driver: ProviderDriverKind,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    payload: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `${this.driver} provider protocol error: ${this.detail}.`;
  }
}

export const ProviderAdapterV2Error = Schema.Union([
  ProviderAdapterCapabilitiesError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterCloseSessionError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterEnsureThreadError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterForkThreadError,
  ProviderAdapterTurnStartError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterSteerRunError,
  ProviderAdapterInterruptError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterEventStreamError,
  ProviderAdapterProtocolError,
]);
export type ProviderAdapterV2Error = typeof ProviderAdapterV2Error.Type;

export interface ProviderAdapterV2OpenSessionInput {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly resumeFromSession?: OrchestrationV2ProviderSession;
  /** Native thread to activate while an eager adapter opens its provider process. */
  readonly initialNativeThreadId?: string;
  /** Preserves provider item identity across eager activation of a persisted thread. */
  readonly initialProviderItemIdentityVersion?: 2;
}

export interface ProviderAdapterV2EnsureThreadInput {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly providerSessionId?: ProviderSessionId;
  readonly existingProviderThread?: OrchestrationV2ProviderThread;
}

export interface ProviderAdapterV2TurnInput {
  readonly appThread: OrchestrationV2AppThread;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly runOrdinal: number;
  readonly providerTurnOrdinal: number;
  readonly restartContinuationOfRunId?: RunId;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly message: ProviderAdapterV2TurnMessage;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
}

export interface ProviderAdapterV2SteerInput {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly message: ProviderAdapterV2TurnMessage;
}

export interface ProviderAdapterV2InterruptInput {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  /** When true, the next `startTurn` may respawn the provider runtime (Grok Stop recovery). */
  readonly requestRuntimeRestart?: boolean;
}

export interface ProviderAdapterV2RuntimeRequestResponseInput {
  readonly requestId: RuntimeRequestId;
  readonly decision?: ProviderApprovalDecision;
  readonly answers?: ProviderUserInputAnswers;
  readonly response?: unknown;
}

export interface ProviderAdapterV2ThreadSnapshot {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly providerPayload?: unknown;
}

export interface ProviderAdapterV2ReadThreadSnapshotInput {
  readonly providerThread: OrchestrationV2ProviderThread;
}

export type ProviderAdapterV2RollbackTarget =
  | {
      readonly type: "thread_start";
      readonly checkpointId: CheckpointId;
      readonly appRunOrdinal: 0;
    }
  | {
      readonly type: "provider_turn";
      readonly checkpointId: CheckpointId;
      readonly appRunOrdinal: number;
      readonly providerTurn: OrchestrationV2ProviderTurn;
    };

export interface ProviderAdapterV2RollbackThreadInput {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly target: ProviderAdapterV2RollbackTarget;
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}

export interface ProviderAdapterV2ForkThreadInput {
  readonly sourceProviderThread: OrchestrationV2ProviderThread;
  readonly sourceProviderTurns?: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly providerTurnId?: ProviderTurnId;
  readonly targetThreadId: ThreadId;
  readonly ownerNodeId?: NodeId;
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
}

export interface ProviderAdapterV2EventSubscription {
  readonly events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
  readonly close: Effect.Effect<void>;
}

export interface ProviderAdapterV2HistoricalContext {
  readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
  readonly context: string;
}

/** Why a realtime call's transport stopped. */
export type ProviderAdapterV2RealtimeCallEnd =
  | { readonly type: "closed"; readonly reason: string | null }
  | { readonly type: "error"; readonly message: string };

/** A live realtime voice session started by `startRealtimeCall`. */
export interface ProviderAdapterV2RealtimeCall {
  readonly sdpAnswer: string;
  /** Resolves once when the provider closes or fails the session. */
  readonly ended: Effect.Effect<ProviderAdapterV2RealtimeCallEnd>;
  /** Stops the session. Safe to call after it already ended. */
  readonly stop: Effect.Effect<void, ProviderAdapterV2Error>;
  /**
   * Adds text to the live conversation. `developer` text is context for the
   * voice model, not something the user said.
   */
  readonly appendText: (input: {
    readonly text: string;
    readonly role: ProviderAdapterV2RealtimeTextRole;
  }) => Effect.Effect<void, ProviderAdapterV2Error>;
  /** Gives the voice model text to say aloud now, as its own words. */
  readonly appendSpeech: (text: string) => Effect.Effect<void, ProviderAdapterV2Error>;
}

export type ProviderAdapterV2RealtimeTextRole = "user" | "assistant" | "developer";

/** A final transcript part of the spoken conversation. */
export interface ProviderAdapterV2RealtimeTranscript {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ProviderAdapterV2SessionRuntime {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly providerSessionId: ProviderSessionId;
  readonly providerSession: OrchestrationV2ProviderSession;
  readonly events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
  /**
   * Manager-owned runtimes expose a synchronous subscription so concurrent
   * provider threads receive independent copies of the process event stream.
   * Adapter runtimes may omit this and expose only their single-consumer event stream.
   */
  readonly subscribeEvents?: Effect.Effect<ProviderAdapterV2EventSubscription>;
  /**
   * Adapters whose native runtime can hold pending work outside an active
   * turn (for example Claude background tasks and their wake turns) report it
   * here so the session manager defers idle release while it is pending.
   */
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  /**
   * Per-provider-thread pending work for root-run ingestion stop gates. When
   * present, RunExecutionService uses only this probe (never the session-wide
   * hasPendingBackgroundWork) so sibling native threads cannot pin an
   * unrelated root subscription open.
   */
  readonly hasPendingBackgroundWorkForThread?: (
    providerThread: OrchestrationV2ProviderThread,
  ) => Effect.Effect<boolean>;
  /** Capacity for the requested model/options, independent of native thread usage. */
  readonly getModelContextWindow?: (modelSelection: ModelSelection) => number | undefined;
  /** Whether an option-only change preserves measured native usage and capacity.
   * Compaction thresholds are still discarded. Unknown transitions invalidate usage.
   */
  readonly canReuseContextUsage?: (previous: ModelSelection, next: ModelSelection) => boolean;
  readonly ensureThread: (
    input: ProviderAdapterV2EnsureThreadInput,
  ) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  readonly resumeThread: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly threadId?: ThreadId;
    readonly modelSelection?: ModelSelection;
    readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
  }) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  /** False means the native protocol explicitly does not support history injection. */
  readonly injectHistory?: (
    input: ProviderAdapterV2HistoricalContext & {
      readonly providerThread: OrchestrationV2ProviderThread;
    },
  ) => Effect.Effect<boolean, ProviderAdapterV2Error>;
  readonly startTurn: (
    input: ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly compactThread?: (
    input: ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly steerTurn: (
    input: ProviderAdapterV2SteerInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly interruptTurn: (
    input: ProviderAdapterV2InterruptInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly respondToRuntimeRequest: (
    input: ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly readThreadSnapshot: (
    input: ProviderAdapterV2ReadThreadSnapshotInput,
  ) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2Error>;
  /**
   * Providers that accept product feedback for a thread (#7949, Codex → OpenAI)
   * expose it here; absent means the driver has no feedback channel.
   */
  readonly uploadFeedback?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly reason?: string;
  }) => Effect.Effect<{ readonly feedbackId: string }, ProviderAdapterV2Error>;
  /**
   * Starts a realtime voice session on a native thread (Codex GPT-Live over
   * WebRTC). Absent means the driver has no realtime voice channel.
   */
  readonly startRealtimeCall?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly sdpOffer: string;
    /** Instructions for the voice model. */
    readonly prompt: string;
    /** Conversation history the session starts with (Codex caps this at 128 items). */
    readonly initialItems?: ReadonlyArray<{
      readonly role: ProviderAdapterV2RealtimeTextRole;
      readonly text: string;
    }>;
    /** Developer instructions for the backing agent when the session starts. */
    readonly agentStartInstructions?: string;
    /** Called whenever either side is speaking (transcript deltas). */
    readonly onActivity?: Effect.Effect<void>;
    /** Called with each final transcript part while the session is live. */
    readonly onTranscript?: (
      transcript: ProviderAdapterV2RealtimeTranscript,
    ) => Effect.Effect<void>;
  }) => Effect.Effect<ProviderAdapterV2RealtimeCall, ProviderAdapterV2Error>;
  readonly rollbackThread: (
    input: ProviderAdapterV2RollbackThreadInput,
  ) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2Error>;
  readonly forkThread: (
    input: ProviderAdapterV2ForkThreadInput,
  ) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
}

export interface ProviderAdapterV2Shape {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly getCapabilities: () => Effect.Effect<
    OrchestrationV2ProviderCapabilities,
    ProviderAdapterV2Error
  >;
  readonly planSelectionTransition: (
    input: ProviderSelectionTransitionInput,
  ) => Effect.Effect<ProviderSelectionTransitionPlan, ProviderAdapterV2Error>;
  readonly openSession: (
    input: ProviderAdapterV2OpenSessionInput,
  ) => Effect.Effect<ProviderAdapterV2SessionRuntime, ProviderAdapterV2Error, Scope.Scope>;
}

export class ProviderAdapterV2 extends Context.Service<ProviderAdapterV2, ProviderAdapterV2Shape>()(
  "t3/orchestration-v2/ProviderAdapter/ProviderAdapterV2",
) {}
