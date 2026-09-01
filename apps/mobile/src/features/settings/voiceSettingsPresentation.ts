export interface LunaSettingsPreferencesView {
  readonly lunaHostUrl?: string;
  readonly lunaHostToken?: string;
  readonly lunaEnabled?: boolean;
}

/** Row summary for the Settings list, from device preferences alone. */
export function lunaSettingsSummary(preferences: LunaSettingsPreferencesView | null): string {
  if (preferences === null) return "Loading";
  const configured =
    (preferences.lunaHostUrl?.trim().length ?? 0) > 0 &&
    (preferences.lunaHostToken?.trim().length ?? 0) > 0;
  if (!configured) return "Not set up";
  return (preferences.lunaEnabled ?? true) ? "On" : "Off";
}

export function clampRecordingRetentionDays(value: string): number | null {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed)) return null;
  return Math.min(365, Math.max(1, parsed));
}
