/**
 * The T3 voice sidecar: one voice orchestrator for a stock T3 server.
 *
 * It watches every thread over the server's public RPC, runs GPT-Live calls in
 * its own `codex app-server` on the ChatGPT subscription, and serves the phone
 * at `/voice/rpc`. Configuration comes from the environment:
 *
 * - `T3_VOICE_SERVER_URL`  T3 server origin (default `http://127.0.0.1:3773`)
 * - `T3_VOICE_TOKEN_FILE`  file holding a bearer from `t3 auth session issue --token-only`
 * - `T3_VOICE_HOME`        state directory (default `~/.t3-voice`)
 * - `T3_VOICE_HOST`, `T3_VOICE_PORT`  listen address (default `0.0.0.0:3780`)
 * - `T3_VOICE_CODEX`, `T3_VOICE_CODEX_HOME`  Codex binary and home, if not the defaults
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { HttpRouter } from "effect/unstable/http";

import * as CodexSessions from "./CodexSessions.ts";
import * as Database from "./Database.ts";
import * as Http from "./Http.ts";
import * as T3Client from "./T3Client.ts";
import * as TailnetIdentity from "./TailnetIdentity.ts";
import * as VoiceOrchestrator from "./VoiceOrchestrator.ts";
import * as VoiceSessionRegistry from "./VoiceSessionRegistry.ts";
import * as VoiceStore from "./VoiceStore.ts";

const settings = Config.all({
  serverUrl: Config.String("T3_VOICE_SERVER_URL").pipe(Config.withDefault("http://127.0.0.1:3773")),
  tokenFile: Config.String("T3_VOICE_TOKEN_FILE"),
  home: Config.String("T3_VOICE_HOME").pipe(Config.option),
  host: Config.String("T3_VOICE_HOST").pipe(Config.withDefault("0.0.0.0")),
  port: Config.Port("T3_VOICE_PORT").pipe(Config.withDefault(3780)),
  codexCommand: Config.String("T3_VOICE_CODEX").pipe(Config.option),
  codexHome: Config.String("T3_VOICE_CODEX_HOME").pipe(Config.option),
});

const app = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* settings;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = Option.getOrElse(config.home, () => path.join(NodeOS.homedir(), ".t3-voice"));
    const token = (yield* fs.readFileString(config.tokenFile)).trim();
    // Codex reaches the MCP endpoint over loopback whatever the public bind is.
    const mcpUrl = `http://127.0.0.1:${config.port}/mcp`;

    const registry = VoiceSessionRegistry.layer;
    const t3 = T3Client.layer({ serverUrl: config.serverUrl, token }).pipe(
      Layer.provide(FetchHttpClient.layer),
    );
    const store = VoiceStore.layer.pipe(
      Layer.provide(Database.layer(path.join(home, "voice.sqlite"))),
    );
    const sessions = CodexSessions.layer({
      workspaceRoot: path.join(home, "workspace"),
      mcpUrl,
      ...Option.match(config.codexCommand, {
        onNone: () => ({}),
        onSome: (codexCommand) => ({ codexCommand }),
      }),
      ...Option.match(config.codexHome, {
        onNone: () => ({}),
        onSome: (codexHome) => ({ codexHome }),
      }),
    }).pipe(Layer.provide(registry));
    const orchestrator = VoiceOrchestrator.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(t3, store, sessions)),
    );

    yield* Effect.logInfo("voice.sidecar.starting", {
      serverUrl: config.serverUrl,
      listen: `${config.host}:${config.port}`,
      home,
    });
    // The server starts listening only after T3 is connected and the
    // orchestrator is up, so no request lands on a half-built sidecar.
    const listener = NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: config.host,
      port: config.port,
    }).pipe(Layer.provideMerge(Layer.mergeAll(orchestrator, registry, TailnetIdentity.layer)));
    return HttpRouter.serve(Http.routes).pipe(Layer.provide(listener));
  }),
);

app.pipe(Layer.provide(NodeServices.layer), Layer.launch, NodeRuntime.runMain);
