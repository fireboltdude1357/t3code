import * as NodeOS from "node:os";
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
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

function readCpu() {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length };
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

const counter = (field: string | undefined) =>
  field !== undefined && /^\d+$/.test(field) ? Number(field) : undefined;

function totalNetworkBytes(
  interfaces: ReadonlyArray<{
    readonly receivedBytes: number | undefined;
    readonly sentBytes: number | undefined;
  }>,
): HostResourcesSnapshot["network"] {
  let receivedBytes = 0;
  let sentBytes = 0;
  for (const counters of interfaces) {
    if (counters.receivedBytes === undefined || counters.sentBytes === undefined) return undefined;
    receivedBytes += counters.receivedBytes;
    sentBytes += counters.sentBytes;
  }
  return interfaces.length > 0 ? { receivedBytes, sentBytes } : undefined;
}

/** Sums `/proc/net/dev` over the named interfaces; undefined when none match or a matching row doesn't parse. */
export function linuxNetworkBytes(procNetDev: string, interfaces: ReadonlySet<string>) {
  return totalNetworkBytes(
    procNetDev.split("\n").flatMap((line) => {
      const separator = line.indexOf(":");
      if (separator < 0 || !interfaces.has(line.slice(0, separator).trim())) return [];
      const fields = line
        .slice(separator + 1)
        .trim()
        .split(/\s+/);
      return [{ receivedBytes: counter(fields[0]), sentBytes: counter(fields[8]) }];
    }),
  );
}

/** Sums `netstat -ibn` over the `<Link#N>` row of each `en<N>` interface; undefined when none match or a row doesn't parse. */
export function darwinNetworkBytes(netstat: string) {
  return totalNetworkBytes(
    netstat.split("\n").flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      // `*` marks a down interface, whose counters still count toward the since-boot total.
      if (!/^en\d+\*?$/.test(fields[0] ?? "") || !fields[2]?.startsWith("<Link#")) return [];
      // Address is blank on some rows, so count from the end: Ibytes Opkts Oerrs Obytes Coll.
      return [{ receivedBytes: counter(fields.at(-5)), sentBytes: counter(fields.at(-2)) }];
    }),
  );
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readNetwork = Effect.fn("HostResources.readNetwork")(
    function* () {
      if (platform === "linux") {
        // Only physical NICs have a `device` link, which drops lo, tailscale0, bridges and veths.
        const physical = yield* fs
          .readDirectory("/sys/class/net")
          .pipe(
            Effect.flatMap((names) =>
              Effect.filter(names, (name) => fs.exists(`/sys/class/net/${name}/device`)),
            ),
          );
        return linuxNetworkBytes(yield* fs.readFileString("/proc/net/dev"), new Set(physical));
      }
      if (platform === "darwin") {
        const output = yield* spawner
          .string(
            ChildProcess.make("/usr/sbin/netstat", ["-ibn"], { stdin: "ignore", stderr: "ignore" }),
          )
          .pipe(Effect.timeout("1 second"));
        return darwinNetworkBytes(output);
      }
      return undefined;
    },
    Effect.orElseSucceed(() => undefined),
  );

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previousCpu = readCpu();
    yield* Effect.sleep("200 millis");
    const cpu = readCpu();
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    const cpuUtilization =
      previousCpu.count === cpu.count && totalDelta > 0 && idleDelta >= 0
        ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
        : null;
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
      cpuUtilization,
      cpuCount: cpu.count,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
      network: yield* readNetwork(),
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
