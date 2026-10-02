import {
  ORCHESTRATION_PROTOCOL_VERSION,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

/** The T3 server could not be reached or refused a request. */
export class T3ClientError extends Schema.TaggedError<T3ClientError>()("T3ClientError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The latest shell state: every live project and unarchived thread. */
export interface T3Shell {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}

/**
 * A change to one thread's shell. `previous` is undefined the first time the
 * client sees the thread after a (re)connect, so a fresh snapshot never looks
 * like a burst of new activity.
 */
export interface T3ThreadChange {
  readonly previous: OrchestrationV2ThreadShell | undefined;
  readonly thread: OrchestrationV2ThreadShell;
}

/**
 * Everything the voice sidecar needs from the T3 server, over its public
 * WebSocket RPC. The sidecar never opens T3's database or links its server
 * code, so a stock T3 build serves it.
 */
export interface T3ClientShape {
  readonly environmentId: string;
  /** Current shell, kept live by one `orchestration.subscribeShell` stream. */
  readonly shell: Effect.Effect<T3Shell>;
  readonly threadShell: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null>;
  /** Live per-thread changes after the first snapshot of each connection. */
  readonly threadChanges: Stream.Stream<T3ThreadChange>;
  /** Fires once per (re)connect, after that connection's snapshot is applied. */
  readonly resynced: Stream.Stream<void>;
  readonly threadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, T3ClientError>;
  readonly dispatch: (command: OrchestrationV2Command) => Effect.Effect<void, T3ClientError>;
  readonly launchThread: (
    input: OrchestrationV2ThreadLaunchInput,
  ) => Effect.Effect<ThreadId, T3ClientError>;
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>, T3ClientError>;
}

export class T3Client extends Context.Service<T3Client, T3ClientShape>()(
  "@t3tools/voice/T3Client",
) {}

export interface T3ClientConfig {
  /** HTTP origin of the T3 server, such as `http://127.0.0.1:3773`. */
  readonly serverUrl: string;
  /** Bearer session token from `t3 auth session issue --token-only`. */
  readonly token: string;
}

const makeWsClient = RpcClient.make(WsRpcGroup);
type WsClient = Effect.Success<typeof makeWsClient>;

const WebSocketTicket = Schema.Struct({ ticket: Schema.String });

const toClientError = (message: string) => (cause: unknown) =>
  new T3ClientError({ message, cause });

/** Applies one shell stream item to the in-memory shell. */
const applyShellItem = (
  shell: Map<ThreadId, OrchestrationV2ThreadShell>,
  projects: Map<string, OrchestrationProjectShell>,
  item: OrchestrationV2ShellStreamItem,
): ReadonlyArray<T3ThreadChange> => {
  switch (item.kind) {
    case "snapshot": {
      shell.clear();
      projects.clear();
      for (const project of item.snapshot.projects) projects.set(project.id, project);
      for (const thread of item.snapshot.threads) shell.set(thread.id, thread);
      return [];
    }
    case "project.updated": {
      projects.set(item.project.id, item.project);
      return [];
    }
    case "project.removed": {
      projects.delete(item.projectId);
      return [];
    }
    case "thread.updated": {
      const previous = shell.get(item.thread.id);
      if (item.location === "active" && item.thread.archivedAt === null)
        shell.set(item.thread.id, item.thread);
      else shell.delete(item.thread.id);
      return [{ previous, thread: item.thread }];
    }
    case "thread.removed": {
      shell.delete(item.threadId);
      return [];
    }
    case "synchronized":
      return [];
  }
};

export const make = (config: T3ClientConfig) =>
  Effect.gen(function* () {
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const origin = config.serverUrl.replace(/\/+$/, "");
    const threads = new Map<ThreadId, OrchestrationV2ThreadShell>();
    const projects = new Map<string, OrchestrationProjectShell>();
    const changes = yield* PubSub.unbounded<T3ThreadChange>();
    const resyncs = yield* PubSub.unbounded<void>();
    const current = yield* Ref.make<WsClient | undefined>(undefined);
    const connected = yield* Deferred.make<WsClient>();

    const ticket = HttpClientRequest.post(`${origin}/api/auth/websocket-ticket`).pipe(
      HttpClientRequest.bearerToken(config.token),
      http.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(WebSocketTicket)),
      Effect.map(({ ticket }) => ticket),
      Effect.mapError(toClientError("The T3 server refused the voice sidecar's token.")),
    );

    /**
     * One authenticated socket, built per connection attempt because tickets
     * are single-use. The layer lives as long as the session that provides it.
     */
    const socketProtocol = Layer.unwrap(
      ticket.pipe(
        Effect.map((wsTicket) =>
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(
              Socket.layerWebSocket(
                `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(wsTicket)}&clientSurface=voice-sidecar`,
              ),
            ),
            Layer.provide(NodeSocket.layerWebSocketConstructor),
            Layer.provide(RpcSerialization.layerJson),
          ),
        ),
      ),
    );

    /** Holds a connection and mirrors the shell until the socket fails. */
    const session = Effect.gen(function* () {
      const client = yield* makeWsClient;
      yield* Effect.addFinalizer(() => Ref.set(current, undefined));
      yield* client["orchestration.subscribeShell"]({}).pipe(
        Stream.runForEach((item) =>
          Effect.gen(function* () {
            const applied = applyShellItem(threads, projects, item);
            if (item.kind === "snapshot") {
              yield* Ref.set(current, client);
              yield* Deferred.succeed(connected, client);
              yield* Effect.logInfo("voice.t3.synced", { threads: threads.size });
              yield* PubSub.publish(resyncs, undefined);
            }
            yield* PubSub.publishAll(changes, applied);
          }),
        ),
      );
      return yield* new T3ClientError({ message: "The T3 shell stream ended." });
    }).pipe(Effect.scoped, Effect.provide(socketProtocol));

    yield* session.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("voice.t3.disconnected", { cause: Cause.pretty(cause) }),
      ),
      // Back off from 1s, but never wait more than 15s between attempts.
      Effect.retry(
        Schedule.min([Schedule.exponential(Duration.seconds(1)), Schedule.spaced("15 seconds")]),
      ),
      Effect.forkScoped,
    );

    const client = Ref.get(current).pipe(
      Effect.flatMap((live) =>
        live === undefined
          ? Effect.fail(new T3ClientError({ message: "The T3 server is not connected." }))
          : Effect.succeed(live),
      ),
    );

    // The first connection supplies the environment id the phone matches on.
    const first = yield* Deferred.await(connected).pipe(
      Effect.timeout(Duration.seconds(60)),
      Effect.mapError(toClientError("The voice sidecar could not reach the T3 server.")),
    );
    const serverConfig = yield* first["server.getConfig"]({}).pipe(
      Effect.mapError(toClientError("Could not read the T3 server's config.")),
    );

    return T3Client.of({
      environmentId: serverConfig.environment.environmentId,
      shell: Effect.sync(() => ({
        projects: [...projects.values()],
        threads: [...threads.values()],
      })),
      threadShell: (threadId) => Effect.sync(() => threads.get(threadId) ?? null),
      threadChanges: Stream.fromPubSub(changes),
      resynced: Stream.fromPubSub(resyncs),
      threadProjection: (threadId) =>
        client.pipe(
          Effect.flatMap((live) => live["orchestration.getThreadProjection"]({ threadId })),
          Effect.mapError(toClientError(`Could not read thread ${threadId}.`)),
        ),
      dispatch: (command) =>
        client.pipe(
          Effect.flatMap((live) => live["orchestration.dispatchCommand"](command)),
          Effect.asVoid,
          Effect.mapError(toClientError(`The T3 server rejected ${command.type}.`)),
        ),
      launchThread: (input) =>
        client.pipe(
          Effect.flatMap((live) => live["orchestration.launchThread"](input)),
          Effect.map((result) => result.threadId),
          Effect.mapError(toClientError("The T3 server could not start the thread.")),
        ),
      providers: client.pipe(
        Effect.flatMap((live) => live["server.getConfig"]({})),
        Effect.map((config) => config.providers),
        Effect.mapError(toClientError("Could not read the T3 server's providers.")),
      ),
    });
  });

export const layer = (config: T3ClientConfig) => Layer.effect(T3Client, make(config));
