import {
  VOICE_SIDECAR_INFO_PATH,
  VOICE_SIDECAR_RPC_PATH,
  VoiceRpcGroup,
  type VoiceSidecarInfo,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import packageJson from "../package.json" with { type: "json" };
import { VoiceToolkitHandlersLive } from "./mcp/handlers.ts";
import { VoiceToolkit } from "./mcp/tools.ts";
import { VoiceMcpCaller } from "./mcp/VoiceMcpCaller.ts";
import { T3Client } from "./T3Client.ts";
import { TailnetIdentity } from "./TailnetIdentity.ts";
import { VoiceOrchestrator } from "./VoiceOrchestrator.ts";
import { VoiceSessionRegistry } from "./VoiceSessionRegistry.ts";

/** Lets the phone match this sidecar to one of its T3 environments. Public by design. */
const infoRoute = HttpRouter.add(
  "GET",
  VOICE_SIDECAR_INFO_PATH,
  T3Client.use((t3) =>
    Effect.succeed(
      HttpServerResponse.jsonUnsafe({
        environmentId: t3.environmentId,
        version: packageJson.version ?? "0.0.0",
      } satisfies VoiceSidecarInfo),
    ),
  ),
);

const forbidden = HttpServerResponse.jsonUnsafe(
  { error: "forbidden", message: "Voice calls are limited to this tailnet's owner." },
  { status: 403 },
);

/**
 * The phone's call stream. Only the host itself and devices that belong to
 * the host's own Tailscale user may connect; the phone sends no credential.
 */
const rpcRoute = HttpRouter.add(
  "GET",
  VOICE_SIDECAR_RPC_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const identity = yield* TailnetIdentity;
    const address = Option.getOrUndefined(request.remoteAddress);
    if (!(yield* identity.isOwner(address))) {
      yield* Effect.logWarning("voice.rpc.rejected", { address });
      return forbidden;
    }
    const voice = yield* VoiceOrchestrator;
    const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* RpcServer.make(VoiceRpcGroup, { disableTracing: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(
        VoiceRpcGroup.toLayer({
          "voiceSession.open": (input) => voice.open(input),
          "voiceSession.respond": (input) => voice.respond(input),
        }),
      ),
      Effect.forkScoped,
    );
    return yield* httpEffect;
  }).pipe(Effect.provide(RpcSerialization.layerJson)),
);

type McpHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  VoiceMcpCaller
>;

/** Resolves each MCP request's bearer token to the session thread that owns it. */
const McpAuthLive = HttpRouter.middleware<{ provides: VoiceMcpCaller }>()(
  VoiceSessionRegistry.use((registry) =>
    Effect.succeed((httpEffect: McpHttpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization ?? "";
        const token = authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length).trim()
          : "";
        const sessionThreadId = yield* registry.byToken(token);
        if (Option.isNone(sessionThreadId)) {
          yield* Effect.logWarning("voice.mcp.rejected", { hasToken: token.length > 0 });
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_mcp_credential" },
            { status: 401, headers: { "www-authenticate": "Bearer" } },
          );
        }
        const response = yield* httpEffect.pipe(
          Effect.provideService(VoiceMcpCaller, { sessionThreadId: sessionThreadId.value }),
        );
        // Codex treats an empty 200 to a notification as an error; MCP wants 202.
        return response.status === 200 && response.body._tag === "Empty"
          ? HttpServerResponse.setStatus(response, 202)
          : response;
      }),
    ),
  ),
).layer;

const mcpLayer = McpServer.toolkit(VoiceToolkit).pipe(
  Layer.provide(VoiceToolkitHandlersLive),
  Layer.provideMerge(
    McpServer.layerHttp({
      name: "T3 Voice",
      version: packageJson.version ?? "0.0.0",
      path: "/mcp",
      protocols: [McpProtocol.v2025_06_18],
    }).pipe(Layer.provide(McpAuthLive)),
  ),
);

export const routes = Layer.mergeAll(infoRoute, rpcRoute, mcpLayer);
