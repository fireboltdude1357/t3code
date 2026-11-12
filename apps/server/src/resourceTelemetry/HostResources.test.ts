import { assert, describe, expect, it } from "@effect/vitest";
import type * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as HostResources from "./HostResources.ts";

// An 8-CPU host; every cpus() call advances each CPU by 100 ms at `host.busy` utilization.
const host = vi.hoisted(() => ({ busy: 0, reads: 0 }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOS>();
  return {
    ...actual,
    totalmem: () => 4 * 1024 ** 3,
    cpus: () => {
      const elapsed = 100 * host.reads++;
      const times = {
        user: elapsed * host.busy,
        nice: 0,
        sys: 0,
        idle: elapsed * (1 - host.busy),
        irq: 0,
      };
      return Array.from({ length: 8 }, () => ({ model: "test", speed: 1, times }));
    },
  };
});
const setup = (busy = 0) => {
  host.busy = busy;
  host.reads = 0;
};

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const cgroup = "/sys/fs/cgroup/t3.slice/server.scope";
const unlimitedCgroup = {
  "/proc/self/cgroup": ["0::/t3.slice/server.scope\n"],
  "/proc/meminfo": [`MemTotal: ${4 * 1024 * 1024} kB\nMemAvailable: ${2 * 1024 * 1024} kB\n`],
  [`${cgroup}/cpu.max`]: ["max 100000\n"],
  [`${cgroup}/cpu.stat`]: ["usage_usec 5000000\n"],
  [`${cgroup}/memory.max`]: ["max\n"],
  [`${cgroup}/memory.current`]: [`${600 * MiB}\n`],
  [`${cgroup}/memory.stat`]: [`anon ${450 * MiB}\ninactive_file ${100 * MiB}\n`],
};

// Each path serves its values in order and repeats the last one.
const linuxHost = (files: Record<string, ReadonlyArray<string>>) => {
  const reads = new Map<string, number>();
  return HostResources.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          readFileString: (path) => {
            const values = files[path];
            if (!values) {
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: path,
                }),
              );
            }
            const index = reads.get(path) ?? 0;
            reads.set(path, index + 1);
            return Effect.succeed(values[Math.min(index, values.length - 1)]!);
          },
        }),
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("HostResources spawned on linux")),
        ),
      ),
    ),
  );
};

const read = Effect.gen(function* () {
  const host = yield* HostResources.HostResources;
  const fiber = yield* Effect.forkChild(host.read);
  yield* TestClock.adjust("200 millis");
  return yield* Fiber.join(fiber);
});

describe("HostResources.layer", () => {
  it.effect("reports the CPU quota and usage of the server's cgroup", () =>
    Effect.gen(function* () {
      setup();
      const snapshot = yield* read;

      // One CPU of quota, 150 ms of it used during the 200 ms sample.
      assert.strictEqual(snapshot.cpuCount, 1);
      assert.strictEqual(snapshot.cpuUtilization, 0.75);
    }).pipe(
      Effect.provide(
        linuxHost({
          ...unlimitedCgroup,
          [`${cgroup}/cpu.max`]: ["100000 100000\n"],
          [`${cgroup}/cpu.stat`]: [
            "usage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\n",
            "usage_usec 5150000\nuser_usec 4100000\nsystem_usec 1050000\n",
          ],
        }),
      ),
    ),
  );

  it.effect("reports memory against the server cgroup's memory.max", () =>
    Effect.gen(function* () {
      setup();
      const snapshot = yield* read;

      assert.strictEqual(snapshot.totalMemoryBytes, GiB);
      // 600 MiB charged, of which 100 MiB is reclaimable page cache.
      assert.strictEqual(snapshot.availableMemoryBytes, GiB - 500 * MiB);
    }).pipe(
      Effect.provide(
        linuxHost({
          ...unlimitedCgroup,
          [`${cgroup}/memory.max`]: [`${GiB}\n`],
        }),
      ),
    ),
  );

  it.effect("counts a busy host against an idle, quota-limited server cgroup", () =>
    Effect.gen(function* () {
      // Agents in sibling cgroups keep the host 90% busy; the server's own cgroup is idle.
      setup(0.9);
      const snapshot = yield* read;

      assert.strictEqual(snapshot.cpuCount, 2);
      // Only 0.8 of 8 host CPUs are free, which is 60% of the 2-CPU quota in use.
      assert.closeTo(snapshot.cpuUtilization ?? Number.NaN, 0.6, 1e-9);
    }).pipe(
      Effect.provide(
        linuxHost({
          ...unlimitedCgroup,
          [`${cgroup}/cpu.max`]: ["200000 100000\n"],
        }),
      ),
    ),
  );

  it.effect("samples the CPUs the server is pinned to by id, not by os.cpus() index", () =>
    Effect.gen(function* () {
      setup();
      const snapshot = yield* read;

      assert.strictEqual(snapshot.cpuCount, 1);
      assert.strictEqual(snapshot.cpuUtilization, 1);
    }).pipe(
      Effect.provide(
        linuxHost({
          ...unlimitedCgroup,
          "/proc/self/status": ["Name:\tnode\nCpus_allowed_list:\t4\n"],
          // CPU 1 is offline; the server's CPU 4 is saturated, everything else is idle.
          "/proc/stat": [0, 100].map((elapsed) =>
            [0, 2, 3, 4, 5, 6, 7]
              .map((id) =>
                id === 4
                  ? `cpu${id} ${elapsed} 0 0 0 0 0 0 0`
                  : `cpu${id} 0 0 0 ${elapsed} 0 0 0 0`,
              )
              .join("\n"),
          ),
        }),
      ),
    ),
  );

  it.effect("keeps host memory when the cgroup's memory.current is unreadable", () =>
    Effect.gen(function* () {
      setup();
      const snapshot = yield* read;

      assert.strictEqual(snapshot.totalMemoryBytes, 4 * GiB);
      assert.strictEqual(snapshot.availableMemoryBytes, 2 * GiB);
    }).pipe(
      Effect.provide(
        linuxHost({
          ...unlimitedCgroup,
          [`${cgroup}/memory.max`]: [`${GiB}\n`],
          [`${cgroup}/memory.current`]: [""],
        }),
      ),
    ),
  );

  it.effect("keeps host values when the cgroup has no limits", () =>
    Effect.gen(function* () {
      setup(0.25);
      const snapshot = yield* read;

      assert.strictEqual(snapshot.cpuCount, 8);
      assert.closeTo(snapshot.cpuUtilization ?? Number.NaN, 0.25, 1e-9);
      assert.deepStrictEqual(snapshot.cpuCoreUtilization, Array(8).fill(0.25));
      assert.strictEqual(snapshot.availableMemoryBytes, 2 * GiB);
    }).pipe(Effect.provide(linuxHost(unlimitedCgroup))),
  );

  it.effect("counts CPU used by reclaimable cgroups as idle", () =>
    Effect.gen(function* () {
      setup();
      const snapshot = yield* read;

      // The host is 90% busy, and 4 of its 8 CPUs went to the reclaimable CI slice.
      assert.strictEqual(snapshot.cpuCount, 8);
      assert.closeTo(snapshot.cpuUtilization ?? Number.NaN, 0.4, 1e-9);
    }).pipe(
      Effect.provide(
        linuxHost({
          ...unlimitedCgroup,
          "/proc/self/status": ["Name:\tnode\nCpus_allowed_list:\t0-7\n"],
          // /proc/stat counts USER_HZ ticks, 20 per CPU over the 200 ms sample.
          "/proc/stat": [0, 1].map((ticks) =>
            Array.from(
              { length: 8 },
              (_, id) => `cpu${id} ${18 * ticks} 0 0 ${2 * ticks} 0 0 0 0`,
            ).join("\n"),
          ),
          "/sys/fs/cgroup/ci.slice/cpu.stat": ["usage_usec 1000000\n", "usage_usec 1800000\n"],
        }).pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                T3CODE_RECLAIMABLE_CPU_CGROUPS: "/sys/fs/cgroup/ci.slice",
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("falls back to host load when the cgroup's cpu.stat is unreadable", () =>
    Effect.gen(function* () {
      setup(0.9);
      const snapshot = yield* read;

      assert.strictEqual(snapshot.cpuCount, 2);
      assert.closeTo(snapshot.cpuUtilization ?? Number.NaN, 0.6, 1e-9);
    }).pipe(
      Effect.provide(
        linuxHost({
          ...unlimitedCgroup,
          [`${cgroup}/cpu.max`]: ["200000 100000\n"],
          [`${cgroup}/cpu.stat`]: [""],
        }),
      ),
    ),
  );
});

const sample = (idle: number, total: number) => ({ idle, total, count: 4 });

describe("hostCpuUtilization", () => {
  it("reports the busy share of the interval", () => {
    expect(HostResources.hostCpuUtilization(sample(0, 0), sample(100, 1000))).toBe(0.9);
  });

  it("counts reclaimable cgroup cores as idle", () => {
    expect(HostResources.hostCpuUtilization(sample(0, 0), sample(100, 1000), 2.4)).toBeCloseTo(0.3);
  });

  it("returns null when the core count changes", () => {
    expect(
      HostResources.hostCpuUtilization(sample(0, 0), { ...sample(100, 1000), count: 8 }),
    ).toBeNull();
  });
});

const core = (idle: number, user: number): NodeOS.CpuInfo => ({
  model: "test",
  speed: 0,
  times: { idle, user, nice: 0, sys: 0, irq: 0 },
});

describe("cpuCoreUtilization", () => {
  it("reports each core's busy share in core order", () => {
    expect(
      HostResources.cpuCoreUtilization([core(0, 0), core(0, 0)], [core(100, 900), core(750, 250)]),
    ).toEqual([0.9, 0.25]);
  });

  it("returns null for a core whose counters gave no valid delta", () => {
    expect(
      HostResources.cpuCoreUtilization(
        [core(500, 500), core(500, 500), core(0, 0)],
        [core(500, 500), core(400, 700), core(0, 100)],
      ),
    ).toEqual([null, null, 1]);
  });

  it("returns undefined when the core count changes", () => {
    expect(
      HostResources.cpuCoreUtilization([core(0, 0)], [core(100, 900), core(100, 900)]),
    ).toBeUndefined();
  });
});

const procNetDev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 23408871028 6782044    0    0    0     0          0         0 23408871028 6782044    0    0    0     0       0          0
enp3s0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
  wlo1: 85530775691 66378879    0    1    0     0          0         0 24756189235 24346859    0 3244    0     0       0          0
tailscale0: 8498985014 4456005    0    0    0     0          0         0 774082475 2320209    0    0    0     0       0          0
`;

describe("linuxNetworkBytes", () => {
  it("sums only the named interfaces", () => {
    expect(HostResources.linuxNetworkBytes(procNetDev, new Set(["enp3s0", "wlo1"]))).toEqual({
      receivedBytes: 85530775691,
      sentBytes: 24756189235,
    });
  });

  it("omits the counters when no interface matches or a matching row is cut short", () => {
    expect(HostResources.linuxNetworkBytes(procNetDev, new Set(["eth0"]))).toBeUndefined();
    expect(
      HostResources.linuxNetworkBytes("  eth0: 100 2 0 0\n", new Set(["eth0"])),
    ).toBeUndefined();
  });
});

const netstat = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                       2337949     0 3072730592  2337949     0 3072730592     0
lo0        16384 127           127.0.0.1        2337949     - 3072730592  2337949     - 3072730592     -
en1        1500  <Link#8>    36:0a:f1:d2:5c:80        0     0          0        0     0          0     0
bridge0    1500  <Link#12>   36:0a:f1:d2:5c:80        0     0          0        0     0          0     0
ap1*       1500  <Link#10>   6e:83:cd:fc:b0:44        0     0          0        0     0          0     0
en0        1500  <Link#11>   4e:c3:b6:78:b6:e9 55449810     0 63297830230 37592764     0 30402620047     0
en0        1500  192.168.1     192.168.1.112   55449810     - 63297830230 37592764     - 30402620047     -
awdl0      1500  <Link#13>   26:9c:94:6e:e9:64       17     0       5067      256     0      27385     0
utun5      1280  <Link#21>                      4130221     0 1325126032 17127153     0 20217673496     0
`;

describe("darwinNetworkBytes", () => {
  it("sums the link row of each en interface", () => {
    expect(HostResources.darwinNetworkBytes(netstat)).toEqual({
      receivedBytes: 63297830230,
      sentBytes: 30402620047,
    });
  });

  it("keeps counting an interface that went down", () => {
    const down =
      "en5*       1500  <Link#22>   4e:c3:b6:78:b6:ea      10     0       1000       20     0       2000     0\n";
    expect(HostResources.darwinNetworkBytes(netstat + down)).toEqual({
      receivedBytes: 63297830230 + 1000,
      sentBytes: 30402620047 + 2000,
    });
  });

  it("omits the counters when the output has no en link rows", () => {
    expect(HostResources.darwinNetworkBytes("")).toBeUndefined();
  });
});
