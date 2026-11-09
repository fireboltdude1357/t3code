import Constants from "expo-constants";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { type ReleaseChannel, releaseResourceAttributes } from "@t3tools/shared/releaseResource";
import * as RelayTracing from "@t3tools/shared/relayTracing";

import { hasTracingPublicConfig, resolveCloudPublicConfig } from "../cloud/publicConfig";
import { recordConnectionTimings } from "../diagnostics/connection-timings-model";

export interface TracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly serviceInstanceId: string;
  readonly appVariant: string;
}

const RELEASE_CHANNEL_BY_VARIANT: Readonly<Record<string, ReleaseChannel | undefined>> = {
  development: "dev",
  preview: "preview",
  production: "stable",
};

export function resolveTracingConfig(): TracingConfig | null {
  const config = resolveCloudPublicConfig();
  if (!hasTracingPublicConfig(config)) {
    return null;
  }
  const { tracesUrl, tracesDataset, tracesToken } = config.observability;
  return { tracesUrl, tracesDataset, tracesToken };
}

export function layerFromConfig(config: TracingConfig | null, resource: TracingResource) {
  const channel =
    typeof __DEV__ !== "undefined" && __DEV__
      ? "dev"
      : RELEASE_CHANNEL_BY_VARIANT[resource.appVariant];
  const layerRelayTracer = RelayTracing.layer(config, {
    serviceName: "t3code-mobile",
    serviceVersion: resource.serviceVersion,
    runtime: "react-native",
    serviceInstanceId: resource.serviceInstanceId,
    client: `mobile-${resource.appVariant}`,
    attributes: channel && releaseResourceAttributes(channel),
  });
  // Relay-traced work swaps the tracer, so both tracers record connection timings.
  return Layer.merge(
    Layer.succeed(Tracer.Tracer, recordConnectionTimings(Tracer.nativeTracer)),
    Layer.effect(
      RelayTracing.RelayClientTracer,
      Effect.map(
        RelayTracing.RelayClientTracer,
        Option.map((tracer) => recordConnectionTimings(tracer)),
      ),
    ).pipe(Layer.provide(layerRelayTracer)),
  );
}

export const layer = layerFromConfig(resolveTracingConfig(), {
  serviceVersion: Constants.expoConfig?.version,
  serviceInstanceId: Constants.sessionId,
  appVariant:
    typeof Constants.expoConfig?.extra?.appVariant === "string"
      ? Constants.expoConfig.extra.appVariant
      : "unknown",
});
