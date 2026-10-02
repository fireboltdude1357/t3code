import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { VoiceSessionRegistry } from "./VoiceSessionRegistry.ts";
import {
  type PreparedSessionThread,
  type RealtimeCall,
  type RealtimeCallEnd,
  SESSION_AGENT_INSTRUCTIONS,
  type StartRealtimeCallInput,
  VOICE_SESSION_MODEL,
  VOICE_SESSION_TOOLS,
  VoiceSessionError,
  VoiceSessionService,
  type VoiceSessionServiceShape,
} from "./VoiceSessionService.ts";

export interface CodexSessionsConfig {
  /** The Codex binary. Defaults to `codex` on PATH. */
  readonly codexCommand?: string;
  /** `CODEX_HOME` for the child. Defaults to the inherited one. */
  readonly codexHome?: string;
  /** Working directory of every session thread. Created on first prepare. */
  readonly workspaceRoot: string;
  /** The sidecar's MCP endpoint, which serves the `voice_*` tools. */
  readonly mcpUrl: string;
}

/** The MCP server name session threads see. Codex prefixes tool calls with it. */
export const VOICE_MCP_SERVER = "voice";

const SETUP_TIMEOUT = "120 seconds";
const ANSWER_TIMEOUT = "30 seconds";
const RELEASE_REQUEST_TIMEOUT = "10 seconds";
/** How long `thread/realtime/stop` may take before the call is ended locally. */
const STOP_TIMEOUT = "5 seconds";

/**
 * The child environment: the parent's, minus anything that could bill the
 * OpenAI API or confuse a T3 process. Codex realtime falls back to
 * `OPENAI_API_KEY` when it is set, and Tanner's shell exports it.
 */
export const codexChildEnvironment = (
  parent: Readonly<Record<string, string | undefined>>,
  codexHome?: string,
): Record<string, string> => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (key === "OPENAI_API_KEY" || key.startsWith("T3_") || key.startsWith("T3CODE_")) continue;
    environment[key] = value;
  }
  if (codexHome !== undefined) environment.CODEX_HOME = codexHome;
  return environment;
};

/**
 * `thread/start` params for a session thread. The thread runs read-only with
 * approvals off, so Codex would deny every MCP call that asks for approval;
 * each voice tool is pre-approved instead and enforces its own gates.
 */
export const sessionThreadStartParams = (input: {
  readonly workspaceRoot: string;
  readonly mcpUrl: string;
  readonly token: string;
}): CodexSchema.V2ThreadStartParams => ({
  model: VOICE_SESSION_MODEL,
  cwd: input.workspaceRoot,
  approvalPolicy: "never",
  sandbox: "read-only",
  config: {
    mcp_servers: {
      [VOICE_MCP_SERVER]: {
        url: input.mcpUrl,
        http_headers: { Authorization: `Bearer ${input.token}` },
        tools: Object.fromEntries(
          VOICE_SESSION_TOOLS.map((tool) => [tool, { approval_mode: "approve" }]),
        ),
      },
    },
  },
});

interface RealtimeCallState {
  readonly answer: Deferred.Deferred<string, VoiceSessionError>;
  readonly ended: Deferred.Deferred<RealtimeCallEnd>;
  readonly onActivity: ((role: "user" | "assistant") => Effect.Effect<void>) | undefined;
  readonly onTranscript: StartRealtimeCallInput["onTranscript"];
}

/** One `codex app-server` child and the per-thread state routed through it. */
interface Connection {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly scope: Scope.Closeable;
  readonly alive: Ref.Ref<boolean>;
  /** Live realtime calls by native thread id. */
  readonly calls: Ref.Ref<ReadonlyMap<string, RealtimeCallState>>;
  /** Setup turns in flight by native thread id. */
  readonly setupTurns: Ref.Ref<ReadonlyMap<string, Deferred.Deferred<void, VoiceSessionError>>>;
}

const isVoiceSessionError = Schema.is(VoiceSessionError);

const without = <V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

/** Keeps a user-facing error as-is and replaces anything else with `fallback`, logged. */
const toSessionError =
  (fallback: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, VoiceSessionError, R> =>
    effect.pipe(
      Effect.tapError((cause) =>
        isVoiceSessionError(cause)
          ? Effect.void
          : Effect.logWarning("voice.codex.request-failed", { fallback, cause }),
      ),
      Effect.mapError((cause) =>
        isVoiceSessionError(cause) ? cause : new VoiceSessionError({ message: fallback }),
      ),
    );

/** Handlers run in the protocol reader loop; a failure or defect there would kill it. */
const guarded = (label: string) => (effect: Effect.Effect<void>) =>
  effect.pipe(Effect.catchCause((cause) => Effect.logWarning(label, { cause })));

export const make = Effect.fn("voice/CodexSessions.make")(function* (config: CodexSessionsConfig) {
  const registry = yield* VoiceSessionRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const layerScope = yield* Effect.scope;

  const current = yield* SynchronizedRef.make(Option.none<Connection>());
  const sessionThreads = yield* Ref.make<ReadonlyMap<string, Connection>>(new Map());

  const endCall = (connection: Connection, threadId: string, end: RealtimeCallEnd) =>
    Effect.gen(function* () {
      const call = yield* Ref.modify(connection.calls, (calls) => {
        const existing = calls.get(threadId);
        return [existing, existing === undefined ? calls : without(calls, threadId)] as const;
      });
      if (call === undefined) return;
      yield* Deferred.fail(
        call.answer,
        new VoiceSessionError({
          message:
            end.type === "error"
              ? end.message
              : `The voice call closed before it connected${end.reason ? `: ${end.reason}` : "."}`,
        }),
      );
      yield* Deferred.succeed(call.ended, end);
    });

  const registerHandlers = (connection: Connection) =>
    Effect.gen(function* () {
      const { client } = connection;
      const callFor = (threadId: string) =>
        Ref.get(connection.calls).pipe(Effect.map((calls) => calls.get(threadId)));

      yield* client.handleServerNotification("turn/completed", (payload) =>
        Effect.gen(function* () {
          const setup = (yield* Ref.get(connection.setupTurns)).get(payload.threadId);
          // Realtime handoff turns land here too; only the setup turn is awaited.
          if (setup === undefined) return;
          if (payload.turn.status === "completed") {
            yield* Deferred.succeed(setup, undefined);
            return;
          }
          yield* Effect.logWarning("voice.codex.setup-turn-failed", {
            status: payload.turn.status,
            error: payload.turn.error?.message,
          });
          yield* Deferred.fail(
            setup,
            new VoiceSessionError({
              message: `The voice agent failed to start (${payload.turn.status}).`,
            }),
          );
        }).pipe(guarded("voice.codex.turn-completed-failed")),
      );

      yield* client.handleServerNotification("thread/realtime/sdp", (payload) =>
        callFor(payload.threadId).pipe(
          Effect.flatMap((call) =>
            call === undefined ? Effect.void : Deferred.succeed(call.answer, payload.sdp),
          ),
          Effect.asVoid,
          guarded("voice.codex.realtime-sdp-failed"),
        ),
      );
      // An error before the answer fails the start. After it, Codex usually
      // closes the session too, but only `closed` ends the call.
      yield* client.handleServerNotification("thread/realtime/error", (payload) =>
        Effect.gen(function* () {
          const call = yield* callFor(payload.threadId);
          if (call === undefined) return;
          if (yield* Deferred.isDone(call.answer)) {
            yield* Effect.logWarning("voice.codex.realtime-error", {
              threadId: payload.threadId,
              message: payload.message,
            });
            return;
          }
          yield* endCall(connection, payload.threadId, { type: "error", message: payload.message });
        }).pipe(guarded("voice.codex.realtime-error-failed")),
      );
      yield* client.handleServerNotification("thread/realtime/transcript/delta", (payload) =>
        callFor(payload.threadId).pipe(
          Effect.flatMap((call) =>
            call?.onActivity === undefined ||
            (payload.role !== "user" && payload.role !== "assistant")
              ? Effect.void
              : call.onActivity(payload.role),
          ),
          guarded("voice.codex.realtime-activity-failed"),
        ),
      );
      yield* client.handleServerNotification("thread/realtime/transcript/done", (payload) =>
        Effect.gen(function* () {
          const call = yield* callFor(payload.threadId);
          if (call?.onTranscript === undefined) return;
          if (payload.role !== "user" && payload.role !== "assistant") return;
          if (payload.text.trim().length === 0) return;
          yield* call.onTranscript({ role: payload.role, text: payload.text });
        }).pipe(guarded("voice.codex.realtime-transcript-failed")),
      );
      yield* client.handleServerNotification("thread/realtime/closed", (payload) =>
        endCall(connection, payload.threadId, {
          type: "closed",
          reason: payload.reason ?? null,
        }).pipe(guarded("voice.codex.realtime-closed-failed")),
      );

      // Approvals are off, so none should arrive. Decline rather than leave a
      // turn hanging. Other server requests get Codex's method-not-found reply.
      const declined = (method: string) =>
        Effect.logWarning("voice.codex.approval-declined", { method });
      yield* client.handleServerRequest("item/commandExecution/requestApproval", () =>
        declined("item/commandExecution/requestApproval").pipe(Effect.as({ decision: "decline" })),
      );
      yield* client.handleServerRequest("item/fileChange/requestApproval", () =>
        declined("item/fileChange/requestApproval").pipe(Effect.as({ decision: "decline" })),
      );
      const denied = { denied: { rejection: "Voice sessions do not take approvals." } };
      yield* client.handleServerRequest("execCommandApproval", () =>
        declined("execCommandApproval").pipe(Effect.as({ decision: denied })),
      );
      yield* client.handleServerRequest("applyPatchApproval", () =>
        declined("applyPatchApproval").pipe(Effect.as({ decision: denied })),
      );
    });

  /** Spawns and initializes a child. Its scope closes when the child exits. */
  const open = Effect.gen(function* () {
    const scope = yield* Scope.fork(layerScope);
    return yield* Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(config.codexCommand ?? "codex", ["app-server"], {
            cwd: config.workspaceRoot,
            env: codexChildEnvironment(process.env, config.codexHome),
            extendEnv: false,
          }),
        )
        .pipe(Scope.provide(scope));
      const clientContext = yield* Layer.buildWithScope(
        CodexClient.layerChildProcess(handle),
        scope,
      );
      const connection: Connection = {
        client: Context.get(clientContext, CodexClient.CodexAppServerClient),
        scope,
        alive: yield* Ref.make(true),
        calls: yield* Ref.make<ReadonlyMap<string, RealtimeCallState>>(new Map()),
        setupTurns: yield* Ref.make<
          ReadonlyMap<string, Deferred.Deferred<void, VoiceSessionError>>
        >(new Map()),
      };
      // A dead app-server sends no `closed`; end everything that ran on it.
      yield* Scope.addFinalizer(
        scope,
        Effect.gen(function* () {
          yield* Ref.set(connection.alive, false);
          for (const threadId of (yield* Ref.get(connection.calls)).keys()) {
            yield* endCall(connection, threadId, {
              type: "error",
              message: "The Codex session ended.",
            });
          }
          for (const setup of (yield* Ref.get(connection.setupTurns)).values()) {
            yield* Deferred.fail(
              setup,
              new VoiceSessionError({ message: "The Codex session ended." }),
            );
          }
        }),
      );
      // Forked in the layer scope: closing `scope` from a fiber it owns would
      // interrupt the fiber mid-close.
      yield* handle.exitCode.pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.logWarning("voice.codex.app-server-exited", { exit }).pipe(
            Effect.andThen(Scope.close(scope, Exit.void)),
          ),
        ),
        Effect.forkIn(layerScope),
      );
      yield* registerHandlers(connection);
      yield* connection.client.request("initialize", {
        clientInfo: { name: "T3 Code Voice", title: "T3 Code Voice", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      });
      yield* connection.client.notify("initialized", undefined);
      return connection;
    }).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))));
  });

  /** The live child, spawning a new one when there is none or it died. */
  const connection = SynchronizedRef.modifyEffect(current, (existing) =>
    Effect.gen(function* () {
      if (Option.isSome(existing) && (yield* Ref.get(existing.value.alive))) {
        return [existing.value, existing] as const;
      }
      const opened = yield* open;
      return [opened, Option.some(opened)] as const;
    }),
  );

  const stopCall = (connection: Connection, threadId: string) =>
    Effect.gen(function* () {
      if (!(yield* Ref.get(connection.calls)).has(threadId)) return;
      // Stop runs in finalizers, so a child that is alive but not answering
      // must not hold up release; the local call ends either way.
      yield* connection.client.raw
        .request("thread/realtime/stop", { threadId })
        .pipe(
          Effect.timeout(STOP_TIMEOUT),
          Effect.ensuring(endCall(connection, threadId, { type: "closed", reason: "stopped" })),
        );
    }).pipe(toSessionError("Failed to stop the voice call."));

  /**
   * Realtime requests are experimental and missing from the generated client,
   * so they go through `raw.request`.
   */
  const startRealtimeCall = (
    connection: Connection,
    threadId: string,
    input: StartRealtimeCallInput,
  ): Effect.Effect<RealtimeCall, VoiceSessionError> =>
    Effect.gen(function* () {
      const call: RealtimeCallState = {
        answer: yield* Deferred.make<string, VoiceSessionError>(),
        ended: yield* Deferred.make<RealtimeCallEnd>(),
        onActivity: input.onActivity,
        onTranscript: input.onTranscript,
      };
      const registered = yield* Ref.modify(connection.calls, (calls) =>
        calls.has(threadId)
          ? ([false, calls] as const)
          : ([true, new Map(calls).set(threadId, call)] as const),
      );
      if (!registered) {
        return yield* new VoiceSessionError({
          message: "A voice call is already active on this thread.",
        });
      }
      const isLive = Ref.get(connection.calls).pipe(
        Effect.map((calls) => calls.get(threadId) === call),
      );
      const stop = Effect.gen(function* () {
        if (yield* isLive) yield* stopCall(connection, threadId);
      });

      const sdpAnswer = yield* connection.client.raw
        .request("thread/realtime/start", {
          threadId,
          outputModality: "audio",
          // v3 is GPT-Live. v1 and v2 fall back to gpt-realtime.
          version: "v3",
          // v3 accepts only juniper, maple, spruce, ember, vale, breeze, arbor,
          // sol and cove (the default).
          voice: "sol",
          // Always WebRTC, which uses the ChatGPT login. The websocket
          // transport can fall back to API billing; never request it.
          transport: { type: "webrtc", sdp: input.sdpOffer },
          prompt: input.prompt,
          ...(input.initialItems === undefined || input.initialItems.length === 0
            ? {}
            : { initialItems: input.initialItems }),
          ...(input.agentStartInstructions === undefined
            ? {}
            : { realtimeStartInstructions: input.agentStartInstructions }),
        })
        .pipe(
          toSessionError("Failed to start the voice call."),
          Effect.andThen(
            Deferred.await(call.answer).pipe(
              Effect.timeoutOrElse({
                duration: ANSWER_TIMEOUT,
                orElse: () =>
                  Effect.fail(new VoiceSessionError({ message: "The voice call didn't answer." })),
              }),
            ),
          ),
          Effect.onError(() => stop.pipe(Effect.ignore)),
        );

      const appendText: RealtimeCall["appendText"] = ({ text, role }) =>
        connection.client.raw
          .request("thread/realtime/appendText", { threadId, text, role })
          .pipe(Effect.asVoid, toSessionError("Failed to add text to the voice call."));
      const appendSpeech: RealtimeCall["appendSpeech"] = (text) =>
        connection.client.raw
          .request("thread/realtime/appendSpeech", { threadId, text })
          .pipe(Effect.asVoid, toSessionError("Failed to speak in the voice call."));

      return { sdpAnswer, ended: Deferred.await(call.ended), stop, appendText, appendSpeech };
    });

  /**
   * The setup turn gives the agent its instructions before the first handoff,
   * and creates the native thread realtime attaches to (Codex only persists a
   * thread once a turn has started on it).
   */
  const runSetupTurn = (connection: Connection, threadId: string) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void, VoiceSessionError>();
      yield* Ref.update(connection.setupTurns, (turns) => new Map(turns).set(threadId, done));
      yield* connection.client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: SESSION_AGENT_INSTRUCTIONS }],
      });
      yield* Deferred.await(done).pipe(
        Effect.timeoutOrElse({
          duration: SETUP_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new VoiceSessionError({ message: "The voice agent took too long to start." }),
            ),
        }),
      );
    }).pipe(
      Effect.ensuring(Ref.update(connection.setupTurns, (turns) => without(turns, threadId))),
    );

  const release: VoiceSessionServiceShape["release"] = (sessionThreadId) =>
    Effect.gen(function* () {
      yield* registry.unregister(sessionThreadId);
      const connection = yield* Ref.modify(sessionThreads, (threads) => [
        threads.get(sessionThreadId),
        without(threads, sessionThreadId),
      ]);
      if (connection === undefined || !(yield* Ref.get(connection.alive))) return;
      yield* stopCall(connection, sessionThreadId).pipe(
        Effect.catch((cause) => Effect.logWarning("voice.codex.release-stop-failed", { cause })),
      );
      // Archiving unloads the thread and its MCP server; unsubscribing covers a
      // Codex that refuses to archive a loaded thread.
      for (const method of ["thread/archive", "thread/unsubscribe"] as const) {
        yield* connection.client.request(method, { threadId: sessionThreadId }).pipe(
          Effect.timeout(RELEASE_REQUEST_TIMEOUT),
          Effect.catch((cause) =>
            Effect.logDebug("voice.codex.release-request-failed", { method, cause }),
          ),
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("voice.codex.release-failed", { sessionThreadId, cause }),
      ),
    );

  const prepare: VoiceSessionServiceShape["prepare"] = ({ generation }) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(config.workspaceRoot, { recursive: true });
      const live = yield* connection;
      const token = Buffer.from(yield* crypto.randomBytes(32)).toString("base64url");
      const started = yield* live.client.request(
        "thread/start",
        sessionThreadStartParams({
          workspaceRoot: config.workspaceRoot,
          mcpUrl: config.mcpUrl,
          token,
        }),
      );
      const nativeThreadId = started.thread.id;
      const sessionThreadId = ThreadId.make(nativeThreadId);
      yield* Ref.update(sessionThreads, (threads) => new Map(threads).set(nativeThreadId, live));
      // Before the setup turn, which may already call voice tools.
      yield* registry.register(sessionThreadId, token);
      yield* runSetupTurn(live, nativeThreadId).pipe(
        Effect.onError(() => release(sessionThreadId)),
      );
      const prepared: PreparedSessionThread = {
        sessionThreadId,
        startRealtimeCall: (input) => startRealtimeCall(live, nativeThreadId, input),
      };
      return prepared;
    }).pipe(
      toSessionError("The voice session could not start."),
      Effect.annotateLogs({ generation }),
    );

  return VoiceSessionService.of({ prepare, release });
});

/**
 * The voice session service over one lazily spawned `codex app-server` child.
 * Needs `VoiceSessionRegistry` plus `ChildProcessSpawner`, `FileSystem` and
 * `Crypto` (all in `NodeServices.layer`).
 */
export const layer = (config: CodexSessionsConfig) =>
  Layer.effect(VoiceSessionService, make(config));
