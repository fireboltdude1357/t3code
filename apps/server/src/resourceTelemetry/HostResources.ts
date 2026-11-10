import * as NodeOS from "node:os";
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class HostResources extends Context.Service<
  HostResources,
  { readonly read: Effect.Effect<HostResourcesSnapshot> }
>()("t3/resourceTelemetry/HostResources") {}

/** Cumulative CPU milliseconds across all cores; `reclaimable` is null when no cgroup is configured or readable. */
interface CpuSample {
  readonly idle: number;
  readonly total: number;
  readonly count: number;
  readonly reclaimable: number | null;
}

function readCpu(reclaimable: number | null): CpuSample {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length, reclaimable };
}

/** Busy share between two samples, counting reclaimable cgroup time as idle. */
export function cpuUtilization(previous: CpuSample, current: CpuSample): number | null {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (previous.count !== current.count || totalDelta <= 0 || idleDelta < 0) return null;
  const reclaimableDelta =
    previous.reclaimable !== null && current.reclaimable !== null
      ? Math.max(0, current.reclaimable - previous.reclaimable)
      : 0;
  return Math.min(1, Math.max(0, 1 - (idleDelta + reclaimableDelta) / totalDelta));
}

function darwinAvailableMemory(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  // vm_stat excludes speculative from free; add it once, without overlapping purgeable pages.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Colon-separated cgroup v2 directories whose work yields to T3 on demand, such as a CI slice
  // with a low cpu.weight. Their CPU time counts as idle so balancing doesn't skip a machine
  // that is only busy with background jobs.
  const reclaimableCgroups =
    platform === "linux"
      ? (yield* Config.String("T3CODE_RECLAIMABLE_CPU_CGROUPS").pipe(Config.withDefault("")))
          .split(":")
          .map((dir) => dir.trim())
          .filter((dir) => dir.length > 0)
      : [];
  const readReclaimable = Effect.forEach(reclaimableCgroups, (dir) =>
    fs.readFileString(`${dir}/cpu.stat`).pipe(
      Effect.map((stat) => /^usage_usec (\d+)$/m.exec(stat)?.[1]),
      Effect.flatMap((usec) =>
        usec === undefined ? Effect.fail("no usage_usec") : Effect.succeed(Number(usec) / 1000),
      ),
    ),
  ).pipe(
    Effect.map((ms) => (ms.length > 0 ? ms.reduce((sum, value) => sum + value, 0) : null)),
    Effect.orElseSucceed(() => null),
  );

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previousCpu = readCpu(yield* readReclaimable);
    yield* Effect.sleep("200 millis");
    const cpu = readCpu(yield* readReclaimable);
    const totalMemoryBytes = NodeOS.totalmem();
    // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
    let availableMemoryBytes = NodeOS.freemem();
    if (platform === "linux") {
      const meminfo = yield* fs
        .readFileString("/proc/meminfo")
        .pipe(Effect.orElseSucceed(() => ""));
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
      if (available) availableMemoryBytes = Number(available) * 1024;
    } else if (platform === "darwin") {
      const output = yield* spawner
        .string(ChildProcess.make("/usr/bin/vm_stat", [], { stdin: "ignore", stderr: "ignore" }))
        .pipe(
          Effect.timeout("1 second"),
          Effect.orElseSucceed(() => ""),
        );
      availableMemoryBytes = darwinAvailableMemory(output) ?? availableMemoryBytes;
    }
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization: cpuUtilization(previousCpu, cpu),
      cpuCount: cpu.count,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
    };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  return HostResources.of({ read: Cache.get(cache, "host") });
});

export const layer = Layer.effect(HostResources, make());
