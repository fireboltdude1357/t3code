import { describe, expect, it } from "@effect/vitest";

import { clampRecordingRetentionDays, lunaSettingsSummary } from "./voiceSettingsPresentation";

describe("luna settings presentation", () => {
  it("summarizes the host setup state from device preferences", () => {
    expect(lunaSettingsSummary(null)).toBe("Loading");
    expect(lunaSettingsSummary({})).toBe("Not set up");
    expect(lunaSettingsSummary({ lunaHostUrl: "https://host:9456" })).toBe("Not set up");
    expect(lunaSettingsSummary({ lunaHostUrl: "https://host:9456", lunaHostToken: "t" })).toBe(
      "On",
    );
    expect(
      lunaSettingsSummary({
        lunaHostUrl: "https://host:9456",
        lunaHostToken: "t",
        lunaEnabled: false,
      }),
    ).toBe("Off");
  });

  it("clamps recording retention to whole days between 1 and 365", () => {
    expect(clampRecordingRetentionDays("30")).toBe(30);
    expect(clampRecordingRetentionDays("0")).toBe(1);
    expect(clampRecordingRetentionDays("9999")).toBe(365);
    expect(clampRecordingRetentionDays("abc")).toBeNull();
    expect(clampRecordingRetentionDays("2.5")).toBeNull();
  });
});
