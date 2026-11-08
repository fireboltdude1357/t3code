// @effect-diagnostics nodeBuiltinImport:off - the regression intercepts the native spawn boundary and stalls the event loop on a FIFO.
// oxlint-disable-next-line t3code/namespace-node-imports -- Mutating the CJS export is necessary to intercept the native ESM binding.
import NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as SpawnHost from "./SpawnHost.ts";

// quarantine: #30183 Platform coverage: this layer is installed only on Linux.
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("SpawnHost readiness", () => {
  // Own file: earlier tests in a shared worker change which loop phase starts the spawn, and the stall stops reproducing.
  it.live("keeps a host whose ready message arrived while the server loop was stalled", () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-spawn-host-"));
      using _directory = {
        [Symbol.dispose]() {
          NodeFS.rmSync(directory, { recursive: true, force: true });
        },
      };
      const readyFifo = NodePath.join(directory, "ready");
      NodeChildProcess.execFileSync("mkfifo", [readyFifo]);
      const nativeSpawn = NodeChildProcess.spawn;
      using _spawn = vi
        .spyOn(NodeChildProcess, "spawn")
        .mockImplementation((command, args, options) => {
          const host = nativeSpawn(command, args, options);
          // Blocks after the readiness timer is armed until ready waits unread in the IPC pipe.
          process.nextTick(() => NodeFS.readFileSync(readyFifo));
          return host;
        });
      using _restore = {
        [Symbol.dispose]() {
          _spawn.mockRestore();
          NodeModule.syncBuiltinESMExports();
        },
      };
      NodeModule.syncBuiltinESMExports();
      yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(ChildProcess.make("/bin/true"));
        expect(yield* child.exitCode).toBe(0);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          SpawnHost.layerHost(
            process.execPath,
            [new URL("./spawnHost.test-fixture.ts", import.meta.url).pathname, readyFifo],
            { readyTimeoutMs: 1 },
          ).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
    }),
  );
});
