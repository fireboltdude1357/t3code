import * as NodeOS from "node:os";
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Arr from "effect/Array";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
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

// Linux CPU list syntax, as in Cpus_allowed_list: "0-3,8,10-11".
function parseCpuList(list: string): ReadonlySet<number> | null {
  const cpus = new Set<number>();
  for (const range of list.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(range.trim());
    if (!match) return null;
    for (let cpu = Number(match[1]); cpu <= Number(match[2] ?? match[1]); cpu++) cpus.add(cpu);
  }
  return cpus;
}

// os.cpus() compacts online CPUs, so its indices are not CPU ids; /proc/stat lines are keyed.
function pinnedCpu(stat: string, allowed: ReadonlySet<number>) {
  const cpu = { idle: 0, total: 0, count: 0 };
  for (const [, id, fields] of stat.matchAll(/^cpu(\d+) (.+)$/gm)) {
    if (!allowed.has(Number(id))) continue;
    const counters = (fields ?? "").trim().split(/\s+/).map(Number);
    const at = (index: number) => counters[index] ?? 0;
    // user nice system idle iowait irq softirq steal
    const idle = at(3) + at(4);
    cpu.idle += idle;
    cpu.total += idle + at(0) + at(1) + at(2) + at(5) + at(6) + at(7);
    cpu.count++;
  }
  return cpu.count > 0 ? cpu : null;
}

function readCpu() {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + coreTotal(times),
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length };
}

function coreTotal(times: NodeOS.CpuInfo["times"]) {
  return times.user + times.nice + times.sys + times.idle + times.irq;
}

/** Busy share of each core between two `os.cpus()` readings; undefined when the core count changed. */
export function cpuCoreUtilization(
  previous: ReadonlyArray<NodeOS.CpuInfo>,
  current: ReadonlyArray<NodeOS.CpuInfo>,
) {
  if (previous.length !== current.length) return undefined;
  return Arr.zipWith(previous, current, ({ times: before }, { times: after }) => {
    const totalDelta = coreTotal(after) - coreTotal(before);
    const idleDelta = after.idle - before.idle;
    return totalDelta > 0 && idleDelta >= 0
      ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
      : null;
  });
}

/**
 * Busy share between two CPU samples, in whatever unit both totals share.
 * `reclaimableCores` is the CPU that reclaimable cgroups used over the interval, in cores; it counts as idle.
 */
export function hostCpuUtilization(
  previous: { readonly idle: number; readonly total: number; readonly count: number },
  current: { readonly idle: number; readonly total: number; readonly count: number },
  reclaimableCores = 0,
): number | null {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (previous.count !== current.count || totalDelta <= 0 || idleDelta < 0) return null;
  return Math.min(1, Math.max(0, 1 - idleDelta / totalDelta - reclaimableCores / current.count));
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

function cgroupNumber(text: string, pattern: RegExp): number | null {
  const value = pattern.exec(text)?.[1];
  return value === undefined ? null : Number(value);
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

  const readFile = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
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
  // Total usage_usec across those cgroups; null when none is configured or any is unreadable.
  const readReclaimableUsage = Effect.forEach(reclaimableCgroups, (dir) =>
    Effect.map(readFile(`${dir}/cpu.stat`), (stat) => cgroupNumber(stat, /^usage_usec (\d+)$/m)),
  ).pipe(
    Effect.map((usages) =>
      usages.reduce<number | null>(
        (sum, usec) => (sum === null || usec === null ? null : sum + usec),
        usages.length > 0 ? 0 : null,
      ),
    ),
  );

  const readNetwork = Effect.fn("HostResources.readNetwork")(
    function* () {
      if (platform === "linux") {
        // Only physical NICs have a `device` link, which drops lo, tailscale0, bridges and veths.
        // Type 1 (Ethernet, which managed Wi-Fi also reports) drops a Wi-Fi monitor interface,
        // whose counters repeat the frames the managed interface already counted.
        const isPhysical = (name: string) =>
          Effect.all([
            fs.exists(`/sys/class/net/${name}/device`),
            fs.readFileString(`/sys/class/net/${name}/type`).pipe(
              Effect.map((type) => type.trim() === "1"),
              Effect.orElseSucceed(() => false),
            ),
          ]).pipe(Effect.map(([hasDevice, isEthernet]) => hasDevice && isEthernet));
        const physical = yield* fs
          .readDirectory("/sys/class/net")
          .pipe(Effect.flatMap((names) => Effect.filter(names, isPhysical)));
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
    // cgroup v2 only; limits of the server's own cgroup, which is `/` inside a container.
    const cgroupPath =
      platform === "linux"
        ? /^0::(\/.*)$/m.exec(yield* readFile("/proc/self/cgroup"))?.[1]
        : undefined;
    const cgroup =
      cgroupPath === undefined ? null : `/sys/fs/cgroup${cgroupPath.replace(/\/$/, "")}`;
    const cpuMax = cgroup
      ? /^(\d+) (\d+)$/.exec((yield* readFile(`${cgroup}/cpu.max`)).trim())
      : null;
    const readCpuUsage = () =>
      cpuMax
        ? Effect.map(readFile(`${cgroup}/cpu.stat`), (stat) =>
            cgroupNumber(stat, /^usage_usec (\d+)$/m),
          )
        : Effect.succeed(null);
    // Affinity (cpuset) pins the server to some CPUs; idle CPUs outside it are of no use.
    const allowedCpus =
      platform === "linux"
        ? parseCpuList(
            /^Cpus_allowed_list:\s*(\S+)$/m.exec(yield* readFile("/proc/self/status"))?.[1] ?? "",
          )
        : null;

    const sampleCpu = () =>
      allowedCpus
        ? Effect.map(readFile("/proc/stat"), (stat) => pinnedCpu(stat, allowedCpus) ?? readCpu())
        : Effect.sync(readCpu);

    const previousCpu = yield* sampleCpu();
    // Per-core load covers every host core, whatever the server is pinned to.
    const previousCores = NodeOS.cpus();
    const previousUsage = yield* readCpuUsage();
    const previousReclaimable = yield* readReclaimableUsage;
    const startedAt = yield* Clock.currentTimeMillis;
    yield* Effect.sleep("200 millis");
    const cpu = yield* sampleCpu();
    const cores = NodeOS.cpus();
    const usage = yield* readCpuUsage();
    const reclaimable = yield* readReclaimableUsage;
    const elapsedMicros = ((yield* Clock.currentTimeMillis) - startedAt) * 1000;
    let cpuCount = cpu.count;
    // CPU samples come in ms (os.cpus) or ticks (/proc/stat), so reclaimable usage goes in as cores.
    const hostUtilization = hostCpuUtilization(
      previousCpu,
      cpu,
      previousReclaimable !== null && reclaimable !== null && elapsedMicros > 0
        ? Math.max(0, reclaimable - previousReclaimable) / elapsedMicros
        : 0,
    );
    let cpuUtilization = hostUtilization;
    if (cpuMax) {
      const capacity = Math.min(Number(cpuMax[1]) / Number(cpuMax[2]), cpu.count);
      cpuCount = Math.max(1, Math.floor(capacity));
      const cgroupIdle =
        previousUsage !== null && usage !== null && elapsedMicros > 0
          ? capacity - (usage - previousUsage) / elapsedMicros
          : null;
      // Agents can run in sibling cgroups (agentScope.ts), so a busy host still counts.
      const hostIdle = hostUtilization === null ? null : cpu.count * (1 - hostUtilization);
      const idle =
        cgroupIdle === null || hostIdle === null
          ? (cgroupIdle ?? hostIdle)
          : Math.min(cgroupIdle, hostIdle);
      cpuUtilization = idle === null ? null : Math.min(1, Math.max(0, 1 - idle / capacity));
    }

    let totalMemoryBytes = NodeOS.totalmem();
    // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
    let availableMemoryBytes = NodeOS.freemem();
    if (platform === "linux") {
      const meminfo = yield* readFile("/proc/meminfo");
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
    const memoryMax = cgroup
      ? cgroupNumber(yield* readFile(`${cgroup}/memory.max`), /^(\d+)$/m)
      : null;
    const memoryCurrent =
      memoryMax === null
        ? null
        : cgroupNumber(yield* readFile(`${cgroup}/memory.current`), /^(\d+)$/m);
    // Without usage, a capped total would read as a near-empty cgroup; keep host values instead.
    if (memoryMax !== null && memoryCurrent !== null) {
      totalMemoryBytes = Math.min(totalMemoryBytes, memoryMax);
      // inactive_file is page cache the kernel reclaims before hitting memory.max.
      const stat = yield* readFile(`${cgroup}/memory.stat`);
      const reclaimable = cgroupNumber(stat, /^inactive_file (\d+)$/m) ?? 0;
      availableMemoryBytes = Math.min(
        availableMemoryBytes,
        memoryMax - (memoryCurrent - reclaimable),
      );
    }
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCoreUtilization: cpuCoreUtilization(previousCores, cores),
      cpuCount,
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
