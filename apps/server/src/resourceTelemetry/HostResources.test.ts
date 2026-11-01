import type * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";

import { cpuCoreUtilization } from "./HostResources.ts";

const core = (idle: number, user: number): NodeOS.CpuInfo => ({
  model: "test",
  speed: 0,
  times: { idle, user, nice: 0, sys: 0, irq: 0 },
});

describe("cpuCoreUtilization", () => {
  it("reports each core's busy share in core order", () => {
    expect(cpuCoreUtilization([core(0, 0), core(0, 0)], [core(100, 900), core(750, 250)])).toEqual([
      0.9, 0.25,
    ]);
  });

  it("returns null for a core whose counters gave no valid delta", () => {
    expect(
      cpuCoreUtilization(
        [core(500, 500), core(500, 500), core(0, 0)],
        [core(500, 500), core(400, 700), core(0, 100)],
      ),
    ).toEqual([null, null, 1]);
  });

  it("returns undefined when the core count changes", () => {
    expect(cpuCoreUtilization([core(0, 0)], [core(100, 900), core(100, 900)])).toBeUndefined();
  });
});
