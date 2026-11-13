import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";

import { connectionTimingLog } from "../diagnostics/connection-timings-model";
import * as Tracing from "./tracing";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

const layerTracingWith = (fetchFn: typeof fetch) =>
  Tracing.layerFromConfig(
    {
      tracesUrl: "https://api.axiom.test/v1/traces",
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    },
    {
      appVariant: "test",
      serviceInstanceId: "test-instance",
      serviceVersion: "1.2.3",
    },
  ).pipe(Layer.provide(layerRemoteHttpClient(fetchFn)));

it.effect("does not let OTLP serialization failures alter application effects", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const layerTracing = layerTracingWith(fetchFn);
  const failure = { durationNanos: 1n };
  const layerTracedApplication = Layer.effectDiscard(
    Effect.fail(failure).pipe(
      Effect.withSpan("mobile.test.failed-span"),
      withRelayClientTracing,
      Effect.exit,
      Effect.flatMap((exit) => {
        const reason = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined;
        return reason && Cause.isFailReason(reason)
          ? Effect.sync(() => {
              expect(reason.error).toBe(failure);
            })
          : Effect.die(new Error("Expected the original typed failure."));
      }),
    ),
  ).pipe(Layer.provide(layerTracing));

  return Layer.build(layerTracedApplication).pipe(
    Effect.scoped,
    Effect.andThen(
      Effect.sync(() => {
        expect(fetchFn).toHaveBeenCalledOnce();
        expect(new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array)).toContain(
          "mobile.test.failed-span",
        );
      }),
    ),
  );
});

it.effect("records connection timings on the local and relay tracers, and still exports", () => {
  connectionTimingLog.clear();
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const layerTracedApplication = Layer.effectDiscard(
    Effect.all([
      Effect.void.pipe(Effect.withSpan("environment.websocket.open"), withRelayClientTracing),
      Effect.void.pipe(Effect.withSpan("environment.websocket.connect")),
    ]),
  ).pipe(Layer.provide(layerTracingWith(fetchFn)));

  return Layer.build(layerTracedApplication).pipe(
    Effect.scoped,
    Effect.andThen(
      Effect.sync(() => {
        expect(connectionTimingLog.records().map((record) => record.phase.span)).toEqual([
          "environment.websocket.connect",
          "environment.websocket.open",
        ]);
        const body = new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array);
        expect(body).toContain("environment.websocket.open");
        expect(body).not.toContain("environment.websocket.connect");
      }),
    ),
  );
});
