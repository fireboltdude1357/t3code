// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type {
  HostPressure,
  HostPressureAgent,
  HostPressureLevel,
  HostResourcesSnapshot,
} from "@t3tools/contracts";
import { CALM_HOST_PRESSURE, ThreadId } from "@t3tools/contracts";
import * as AgentScope from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Arr from "effect/Array";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as EffectConfig from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as Config from "../config.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";

export class HostResources extends Context.Service<
  HostResources,
  {
    readonly read: Effect.Effect<HostResourcesSnapshot>;
    /** Changes only; samples while someone listens. */
    readonly pressure: Stream.Stream<HostPressure>;
    /** The latest pressure, sampling once when nobody listens. */
    readonly readPressure: Effect.Effect<HostPressure>;
  }
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

/** A PSI file's `some` or `full` average over 10 or 60 s, in percent. */
export function psiAverage(
  text: string,
  kind: "some" | "full",
  window: "avg10" | "avg60",
): number | null {
  const value = new RegExp(`^${kind} .*\\b${window}=(\\d+(?:\\.\\d+)?)`, "m").exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

export interface PressureSample {
  /** Linux PSI avg10 percentages for memory. */
  readonly memorySome: number | null;
  readonly memoryFull: number | null;
  readonly agentsMemoryFull: number | null;
  /** macOS `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
  readonly darwinMemoryLevel: number | null;
  /** Linux PSI avg60 percentages; a minute, so a build's burst is not an overload. */
  readonly cpuSome: number | null;
  readonly ioFull: number | null;
  /** One-minute load average per CPU, where PSI is missing. */
  readonly loadPerCpu: number | null;
  readonly diskFreeBytes: number | null;
  readonly diskTotalBytes: number | null;
}

export interface PressureLevels {
  readonly memory: HostPressureLevel;
  readonly cpu: HostPressureLevel;
  readonly io: HostPressureLevel;
  readonly disk: HostPressureLevel;
}

export const CALM: PressureLevels = { memory: "none", cpu: "none", io: "none", disk: "none" };

const RANK = { none: 0, elevated: 1, severe: 2 } as const;
// A level is left only well below where it was entered, so it does not flicker.
const EXIT_RATIO = 0.4;
const GiB = 1024 ** 3;

const worst = (levels: ReadonlyArray<HostPressureLevel>): HostPressureLevel =>
  levels.reduce((left, right) => (RANK[right] > RANK[left] ? right : left), "none");

function grade(
  previous: HostPressureLevel,
  value: number | null,
  elevated: number,
  severe: number,
): HostPressureLevel {
  if (value === null) return "none";
  const holds = (level: HostPressureLevel, threshold: number) =>
    value >= (RANK[previous] >= RANK[level] ? threshold * EXIT_RATIO : threshold);
  if (holds("severe", severe)) return "severe";
  return holds("elevated", elevated) ? "elevated" : "none";
}

function diskLevel(previous: HostPressureLevel, free: number, total: number): HostPressureLevel {
  const below = (level: HostPressureLevel, limit: number) =>
    free < (RANK[previous] >= RANK[level] ? limit * 1.25 : limit);
  if (below("severe", Math.min(5 * GiB, total * 0.05))) return "severe";
  return below("elevated", Math.min(20 * GiB, total * 0.15)) ? "elevated" : "none";
}

/**
 * `full` means every task waited. The agents slice is throttled first, so it
 * gets looser thresholds. A kind with nothing readable keeps its level: a
 * failed read is no evidence the pressure ended.
 */
export function nextPressureLevels(
  previous: PressureLevels,
  sample: PressureSample,
): PressureLevels {
  const memoryRead =
    sample.memorySome !== null ||
    sample.memoryFull !== null ||
    sample.agentsMemoryFull !== null ||
    sample.darwinMemoryLevel !== null;
  const memory = memoryRead
    ? worst([
        grade(previous.memory, sample.memorySome, 10, Number.POSITIVE_INFINITY),
        grade(previous.memory, sample.memoryFull, 2, 10),
        grade(previous.memory, sample.agentsMemoryFull, 5, 20),
        sample.darwinMemoryLevel === null
          ? "none"
          : sample.darwinMemoryLevel >= 4
            ? "severe"
            : sample.darwinMemoryLevel >= 2
              ? "elevated"
              : "none",
      ])
    : previous.memory;
  const cpu =
    sample.cpuSome !== null
      ? grade(previous.cpu, sample.cpuSome, 25, 60)
      : sample.loadPerCpu !== null
        ? grade(previous.cpu, sample.loadPerCpu, 1.5, 3)
        : previous.cpu;
  const io = sample.ioFull === null ? previous.io : grade(previous.io, sample.ioFull, 10, 30);
  const disk =
    sample.diskFreeBytes === null || sample.diskTotalBytes === null
      ? previous.disk
      : diskLevel(previous.disk, sample.diskFreeBytes, sample.diskTotalBytes);
  return { memory, cpu, io, disk };
}

const PRESSURE_INTERVAL = "5 seconds";
const MAX_UNREAD_PRESSURE_SAMPLES = 6;
const HEAVIEST_AGENT_COUNT = 3;
const CPU_SAMPLE_MAX_AGE_MS = 30_000;

/** Up to about an eighth coarser, so ordinary growth does not push an update every sample. */
export function roundCoarsely(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  const step = 2 ** Math.max(20, Math.floor(Math.log2(bytes)) - 3);
  return Math.ceil(bytes / step) * step;
}

/** Half a core below two cores, whole cores above. */
function roundCores(cores: number): number {
  if (!Number.isFinite(cores) || cores <= 0) return 0;
  return cores < 2 ? Math.round(cores * 2) / 2 : Math.round(cores);
}

/** Ranked by exact size: rounding first would tie close agents and could drop the largest. */
export function heaviestAgents(
  agents: ReadonlyArray<HostPressureAgent>,
  by: "memory" | "cpu",
): ReadonlyArray<HostPressureAgent> {
  const size = (agent: HostPressureAgent) =>
    by === "memory" ? agent.memoryBytes : (agent.cpuCores ?? 0);
  return agents
    .filter((agent) => size(agent) > 0)
    .toSorted((left, right) => size(right) - size(left))
    .slice(0, HEAVIEST_AGENT_COUNT)
    .map((agent) => ({
      ...agent,
      memoryBytes: roundCoarsely(agent.memoryBytes),
      cpuCores: agent.cpuCores === null ? null : roundCores(agent.cpuCores),
    }));
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
  const agentScope = yield* AgentScope.AgentScope;
  const nativeTelemetry = yield* NativeTelemetryClient.NativeTelemetryClient;
  const config = yield* Config.ServerConfig;
  const levels = yield* Ref.make(CALM);
  const unreadSamples = yield* Ref.make({ memory: 0, cpu: 0, io: 0, disk: 0 });
  const lastAgentCpu = yield* Ref.make<{
    readonly at: number;
    readonly usage: ReadonlyMap<string, number>;
  } | null>(null);

  const readFile = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
  // Colon-separated cgroup v2 directories whose work yields to T3 on demand, such as a CI slice
  // with a low cpu.weight. Their CPU time counts as idle so balancing doesn't skip a machine
  // that is only busy with background jobs.
  const reclaimableCgroups =
    platform === "linux"
      ? (yield* EffectConfig.String("T3CODE_RECLAIMABLE_CPU_CGROUPS").pipe(
          EffectConfig.withDefault(""),
        ))
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

  // libuv cannot cancel a started `statfs`, so a hung mount gets at most one in flight.
  const pendingStatfs = new Set<string>();
  const readDiskSpace = (directory: string) =>
    Effect.promise(() => {
      if (pendingStatfs.has(directory)) return Promise.resolve(null);
      pendingStatfs.add(directory);
      // An unreadable volume is reported as unknown, not as an error.
      return NodeFSP.statfs(directory)
        .catch(() => null)
        .finally(() => pendingStatfs.delete(directory));
    }).pipe(
      // A hung network mount must not hold the sample.
      Effect.timeoutOption("1 second"),
      Effect.map((stats) =>
        stats._tag === "Some" && stats.value !== null
          ? {
              free: stats.value.bavail * stats.value.bsize,
              total: stats.value.blocks * stats.value.bsize,
            }
          : null,
      ),
    );

  // The volume under the most pressure decides, so a severe small volume is not hidden by a larger one.
  const diskSpace = Effect.gen(function* () {
    const previous = (yield* Ref.get(levels)).disk;
    const volumes = yield* Effect.forEach(
      [...new Set([config.baseDir, config.worktreesDir])],
      readDiskSpace,
      { concurrency: "unbounded" },
    );
    const rank = (volume: { free: number; total: number }) =>
      RANK[diskLevel(previous, volume.free, volume.total)];
    return volumes.reduce<{ free: number; total: number } | null>(
      (chosen, volume) =>
        volume !== null &&
        (chosen === null ||
          rank(volume) > rank(chosen) ||
          (rank(volume) === rank(chosen) && volume.free < chosen.free))
          ? volume
          : chosen,
      null,
    );
  });

  // Untraced: it runs every few seconds while a client listens.
  const samplePressure = Effect.fnUntraced(function* () {
    const linux = platform === "linux";
    const agents = linux ? yield* agentScope.controlGroups : undefined;
    const memoryPsi = linux ? yield* readFile("/proc/pressure/memory") : "";
    const cpuPsi = linux ? yield* readFile("/proc/pressure/cpu") : "";
    const ioPsi = linux ? yield* readFile("/proc/pressure/io") : "";
    const agentsPsi =
      agents === undefined ? "" : yield* readFile(`/sys/fs/cgroup${agents.slice}/memory.pressure`);
    // The running sidecar reads it: under pressure a newly spawned `sysctl` may never start.
    const darwinMemoryLevel =
      platform === "darwin"
        ? yield* nativeTelemetry.memoryPressureLevel.pipe(Effect.orElseSucceed(() => null))
        : null;
    const cpuSome = psiAverage(cpuPsi, "some", "avg60");
    // Windows reports a zero load average, which would read as calm.
    const loadPerCpu =
      cpuSome === null && platform !== "win32"
        ? NodeOS.loadavg()[0]! / Math.max(1, NodeOS.availableParallelism())
        : null;
    const disk = yield* diskSpace;
    const sample: PressureSample = {
      memorySome: psiAverage(memoryPsi, "some", "avg10"),
      memoryFull: psiAverage(memoryPsi, "full", "avg10"),
      agentsMemoryFull: psiAverage(agentsPsi, "full", "avg10"),
      darwinMemoryLevel,
      cpuSome,
      ioFull: psiAverage(ioPsi, "full", "avg60"),
      loadPerCpu,
      diskFreeBytes: disk?.free ?? null,
      diskTotalBytes: disk?.total ?? null,
    };
    const unread = yield* Ref.updateAndGet(unreadSamples, (counts) => ({
      memory:
        sample.memorySome === null &&
        sample.memoryFull === null &&
        sample.agentsMemoryFull === null &&
        darwinMemoryLevel === null
          ? counts.memory + 1
          : 0,
      cpu: cpuSome === null && loadPerCpu === null ? counts.cpu + 1 : 0,
      io: sample.ioFull === null ? counts.io + 1 : 0,
      disk: disk === null ? counts.disk + 1 : 0,
    }));
    const graded = nextPressureLevels(yield* Ref.get(levels), sample);
    // A dead sidecar or a vanished mount must not leave a warning up long after it ended.
    const next = {
      memory: unread.memory >= MAX_UNREAD_PRESSURE_SAMPLES ? "none" : graded.memory,
      cpu: unread.cpu >= MAX_UNREAD_PRESSURE_SAMPLES ? "none" : graded.cpu,
      io: unread.io >= MAX_UNREAD_PRESSURE_SAMPLES ? "none" : graded.io,
      disk: unread.disk >= MAX_UNREAD_PRESSURE_SAMPLES ? "none" : graded.disk,
    } satisfies PressureLevels;
    yield* Ref.set(levels, next);

    // CPU use is a difference of two readings, so it is read every sample while the scopes exist.
    const now = yield* Clock.currentTimeMillis;
    const cpuUsage = new Map(
      agents === undefined
        ? []
        : yield* Effect.forEach(agents.scopes, (scope) =>
            readFile(`/sys/fs/cgroup${scope.path}/cpu.stat`).pipe(
              Effect.map(
                (stat) => [scope.path, cgroupNumber(stat, /^usage_usec (\d+)$/m)] as const,
              ),
            ),
          ),
    );
    const previousCpu = yield* Ref.getAndSet(lastAgentCpu, {
      at: now,
      usage: new Map(
        [...cpuUsage].flatMap(([path, usage]) => (usage === null ? [] : [[path, usage] as const])),
      ),
    });
    const elapsedMicros =
      previousCpu === null || now - previousCpu.at > CPU_SAMPLE_MAX_AGE_MS
        ? null
        : (now - previousCpu.at) * 1000;
    // The more pressured resource names the culprits; `hostPressureRanking` mirrors this.
    const rankBy =
      next.memory === "none" && next.cpu === "none"
        ? null
        : RANK[next.cpu] > RANK[next.memory]
          ? "cpu"
          : "memory";
    const agentUsage =
      rankBy === null || agents === undefined
        ? []
        : yield* Effect.forEach(agents.scopes, (scope) =>
            readFile(`/sys/fs/cgroup${scope.path}/memory.current`).pipe(
              Effect.map((text): HostPressureAgent => {
                const usage = cpuUsage.get(scope.path);
                const before = previousCpu?.usage.get(scope.path);
                return {
                  threadId: scope.threadId === undefined ? null : ThreadId.make(scope.threadId),
                  agent: scope.agent,
                  memoryBytes: Number(text.trim()) || 0,
                  cpuCores:
                    elapsedMicros === null ||
                    elapsedMicros <= 0 ||
                    usage === null ||
                    usage === undefined ||
                    before === undefined
                      ? null
                      : Math.max(0, usage - before) / elapsedMicros,
                };
              }),
            ),
          );
    return {
      ...next,
      diskFreeBytes: next.disk === "none" || disk === null ? null : roundCoarsely(disk.free),
      heaviestAgents: rankBy === null ? [] : heaviestAgents(agentUsage, rankBy),
    } satisfies HostPressure;
  });

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
    const disk = yield* diskSpace;
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCoreUtilization: cpuCoreUtilization(previousCores, cores),
      cpuCount,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
      network: yield* readNetwork(),
      diskFreeBytes: disk?.free ?? null,
      diskTotalBytes: disk?.total ?? null,
    };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  const pressure = yield* Stream.fromEffectSchedule(
    samplePressure(),
    Schedule.spaced(PRESSURE_INTERVAL),
  ).pipe(
    Stream.changesWith((previous, next) => JSON.stringify(previous) === JSON.stringify(next)),
    Stream.share({ capacity: 1, strategy: "sliding", replay: 1 }),
  );
  const readPressure = Stream.runHead(pressure).pipe(
    Effect.map((latest) => (latest._tag === "Some" ? latest.value : CALM_HOST_PRESSURE)),
  );
  return HostResources.of({ read: Cache.get(cache, "host"), pressure, readPressure });
});

export const layer = Layer.effect(HostResources, make());
