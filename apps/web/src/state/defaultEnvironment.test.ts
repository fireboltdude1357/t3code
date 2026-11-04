import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultEnvironmentId } from "./defaultEnvironment";

const primary = EnvironmentId.make("environment-mac");
const wsl = EnvironmentId.make("environment-wsl");

describe("resolveDefaultEnvironmentId", () => {
  it("starts on this device when no machine is saved", () => {
    expect(
      resolveDefaultEnvironmentId({
        savedEnvironmentId: null,
        primaryEnvironmentId: primary,
        connectedEnvironmentIds: [primary, wsl],
      }),
    ).toBe(primary);
  });

  it("starts on the saved machine while it is connected", () => {
    expect(
      resolveDefaultEnvironmentId({
        savedEnvironmentId: wsl,
        primaryEnvironmentId: primary,
        connectedEnvironmentIds: [primary, wsl],
      }),
    ).toBe(wsl);
  });

  it("falls back to this device when the saved machine is disconnected or unknown", () => {
    expect(
      resolveDefaultEnvironmentId({
        savedEnvironmentId: wsl,
        primaryEnvironmentId: primary,
        connectedEnvironmentIds: [primary],
      }),
    ).toBe(primary);
    expect(
      resolveDefaultEnvironmentId({
        savedEnvironmentId: EnvironmentId.make("environment-removed"),
        primaryEnvironmentId: primary,
        connectedEnvironmentIds: [primary, wsl],
      }),
    ).toBe(primary);
  });
});
