import { describe, expect, it } from "@effect/vitest";

import { cpuUtilization } from "./HostResources.ts";

const sample = (idle: number, total: number, reclaimable: number | null = null) => ({
  idle,
  total,
  count: 4,
  reclaimable,
});

describe("cpuUtilization", () => {
  it("reports the busy share of the interval", () => {
    expect(cpuUtilization(sample(0, 0), sample(100, 1000))).toBe(0.9);
  });

  it("counts reclaimable cgroup time as idle", () => {
    expect(cpuUtilization(sample(0, 0, 0), sample(100, 1000, 600))).toBeCloseTo(0.3);
  });

  it("ignores reclaimable time when either reading is missing", () => {
    expect(cpuUtilization(sample(0, 0, null), sample(100, 1000, 600))).toBe(0.9);
  });

  it("returns null when the core count changes", () => {
    expect(cpuUtilization(sample(0, 0), { ...sample(100, 1000), count: 8 })).toBeNull();
  });
});
