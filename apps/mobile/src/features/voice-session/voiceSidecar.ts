import { useAtomValue } from "@effect/atom-react";
import {
  VOICE_SIDECAR_INFO_PATH,
  VOICE_SIDECAR_RPC_PATH,
  VoiceRpcGroup,
  VoiceSidecarInfo,
  type VoiceSessionOpenInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Atom } from "effect/reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../../connection/runtime";

/**
 * Base URL of the voice sidecar, e.g. `http://stl-wsl.tail1fd0aa.ts.net:3780`.
 * Set at build time; voice is unavailable without it. The sidecar trusts the
 * caller's Tailscale identity, so the phone sends no credential.
 */
export const voiceSidecarUrl: string | null =
  process.env.EXPO_PUBLIC_T3_VOICE_URL?.trim().replace(/\/+$/, "") || null;

/**
 * The environment the sidecar serves, or null while it is unknown or
 * unreachable. Kept alive and refetched whenever the app returns to the
 * foreground, so a sidecar started later shows up without a restart.
 */
const voiceSidecarEnvironmentIdAtom = connectionAtomRuntime
  .atom((get) => {
    if (voiceSidecarUrl === null) return Effect.succeed(null);
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") get.refreshSelf();
    });
    get.addFinalizer(() => subscription.remove());
    return HttpClient.get(`${voiceSidecarUrl}${VOICE_SIDECAR_INFO_PATH}`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(VoiceSidecarInfo)),
      Effect.map((info) => info.environmentId),
      Effect.retry({ schedule: Schedule.exponential("2 seconds"), times: 3 }),
    );
  })
  .pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-sidecar:environment"));

/** Id of the environment the voice sidecar can call into, or null when voice is unavailable. */
export function useVoiceSidecarEnvironmentId(): string | null {
  const result = useAtomValue(voiceSidecarEnvironmentIdAtom);
  // A failed refetch hides voice rather than trusting the last answer.
  return result._tag === "Success" ? result.value : null;
}

const makeVoiceRpcClient = RpcClient.make(VoiceRpcGroup);
export type VoiceSidecarClient = Effect.Success<typeof makeVoiceRpcClient>;

/**
 * Connects to the sidecar's RPC socket; the socket closes with the enclosing
 * scope. Retries are off so a dropped socket fails the call and the
 * controller's reconnect takes over.
 */
const connectVoiceSidecar = Effect.fn("connectVoiceSidecar")(function* (baseUrl: string) {
  const socketLayer = Socket.layerWebSocket(
    `${baseUrl.replace(/^http/, "ws")}${VOICE_SIDECAR_RPC_PATH}`,
    { openTimeout: "15 seconds" },
  );
  const protocol = yield* Layer.build(
    Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(Layer.provide(Layer.merge(socketLayer, RpcSerialization.layerJson))),
  );
  return yield* makeVoiceRpcClient.pipe(Effect.provide(protocol));
});

/**
 * Opens one call generation on its own socket, which closes when the stream
 * ends or is dropped. `onClient` receives the connected client so confirm
 * answers can reuse the socket while the call is live.
 */
export function openVoiceSidecarSession(
  baseUrl: string,
  input: VoiceSessionOpenInput,
  onClient: (client: VoiceSidecarClient) => void,
) {
  return Stream.unwrap(
    connectVoiceSidecar(baseUrl).pipe(
      Effect.map((client) => {
        onClient(client);
        return client["voiceSession.open"](input);
      }),
    ),
  );
}
