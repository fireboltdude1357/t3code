import {
  VOICE_SIDECAR_INFO_PATH,
  VOICE_SIDECAR_MEMO_PATH,
  VOICE_SIDECAR_RPC_PATH,
  type VoiceMemoFailure,
  VoiceMemoSubmitParams,
  VoiceRpcGroup,
  type VoiceSidecarInfo,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";

import packageJson from "../package.json" with { type: "json" };
import { VoiceToolkitHandlersLive } from "./mcp/handlers.ts";
import { VoiceToolkit } from "./mcp/tools.ts";
import { VoiceMcpCaller } from "./mcp/VoiceMcpCaller.ts";
import { T3Client } from "./T3Client.ts";
import { TailnetIdentity } from "./TailnetIdentity.ts";
import { VoiceMemos } from "./VoiceMemos.ts";
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

/** Names the sidecar is reached by: loopback, MagicDNS, or a tailnet address. */
const isTrustedHostname = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname.endsWith(".ts.net") ||
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(hostname);

const hostnameOf = (host: string) => host.replace(/:\d+$/, "").toLowerCase();

/**
 * Browsers don't apply CORS to WebSockets, so the source address alone would
 * let any web page on an owner device drive the call. A browser always sends
 * `Origin`; the phone's native socket sends none or its own URL. So an
 * `Origin`, when present, must be this host, and `Host` must be a loopback or
 * tailnet name, which also stops DNS rebinding.
 */
export const isTrustedUpgrade = (host: string | undefined, origin: string | undefined) => {
  if (host === undefined || !isTrustedHostname(hostnameOf(host))) return false;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
};

const forbidden = HttpServerResponse.jsonUnsafe(
  { error: "forbidden", message: "Voice calls are limited to this tailnet's owner." },
  { status: 403 },
);

/**
 * True for the host itself and devices of the host's own Tailscale user, on a
 * loopback or tailnet `Host`, from no browser page but this host's own.
 */
const isOwnerRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const identity = yield* TailnetIdentity;
  const address = Option.getOrUndefined(request.remoteAddress);
  if (!isTrustedUpgrade(request.headers.host, request.headers.origin)) {
    yield* Effect.logWarning("voice.rpc.rejected-origin", {
      host: request.headers.host,
      origin: request.headers.origin,
    });
    return false;
  }
  if (!(yield* identity.isOwner(address))) {
    yield* Effect.logWarning("voice.rpc.rejected", { address });
    return false;
  }
  return true;
});

/**
 * The phone's call stream. Only the host itself and devices that belong to
 * the host's own Tailscale user may connect; the phone sends no credential.
 */
const rpcRoute = HttpRouter.add(
  "GET",
  VOICE_SIDECAR_RPC_PATH,
  Effect.gen(function* () {
    if (!(yield* isOwnerRequest)) return forbidden;
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

const memoFailure = (message: string, status: number) =>
  HttpServerResponse.jsonUnsafe({ message } satisfies VoiceMemoFailure, { status });

/** Memo ids are UUIDs: they end up in a path, and Sotto keys its retries by them. */
const MemoId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
const isMemoId = Schema.is(MemoId);

/**
 * One voice memo: the body is the recording, and the response waits for the
 * spoken reply (see `VOICE_SIDECAR_MEMO_PATH`). Same access rule as the call.
 */
const memoRoute = HttpRouter.add(
  "POST",
  VOICE_SIDECAR_MEMO_PATH,
  Effect.gen(function* () {
    if (!(yield* isOwnerRequest)) return forbidden;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpServerRequest.schemaSearchParams(VoiceMemoSubmitParams).pipe(
      Effect.filterOrFail((decoded) => isMemoId(decoded.memoId)),
      Effect.option,
    );
    if (Option.isNone(params)) return memoFailure("The memo id is missing or malformed.", 400);
    const audio = new Uint8Array(yield* request.arrayBuffer);
    if (audio.length === 0) return memoFailure("The memo had no audio.", 400);
    const memos = yield* VoiceMemos;
    return yield* memos
      .submit({
        memoId: params.value.memoId,
        audio,
        ...(params.value.focusThreadId === undefined
          ? {}
          : { focusThreadId: params.value.focusThreadId }),
      })
      .pipe(
        Effect.map((reply) => HttpServerResponse.jsonUnsafe(reply)),
        Effect.catchTags({
          VoiceSessionError: (error) => Effect.succeed(memoFailure(error.message, 502)),
        }),
      );
  }).pipe(
    Effect.catchTags({
      HttpServerError: () =>
        Effect.succeed(memoFailure("The recording didn't upload completely.", 400)),
    }),
  ),
);

/** A finished memo's spoken reply. */
const memoAudioRoute = HttpRouter.add(
  "GET",
  `${VOICE_SIDECAR_MEMO_PATH}/:memoId/audio`,
  Effect.gen(function* () {
    if (!(yield* isOwnerRequest)) return forbidden;
    const { memoId } = yield* HttpRouter.params;
    const memos = yield* VoiceMemos;
    const audio = memoId === undefined ? Option.none() : yield* memos.audio(memoId);
    return Option.match(audio, {
      onNone: () => memoFailure("That reply is no longer available.", 404),
      onSome: (bytes) => HttpServerResponse.uint8Array(bytes, { contentType: "audio/mp4" }),
    });
  }),
);

export const routes = Layer.mergeAll(infoRoute, rpcRoute, memoRoute, memoAudioRoute, mcpLayer);
