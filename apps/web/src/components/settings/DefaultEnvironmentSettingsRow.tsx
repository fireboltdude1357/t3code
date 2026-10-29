import type { ClientSettings } from "@t3tools/contracts";

import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import { useEnvironments } from "~/state/environments";
import { resolveEnvironmentOptionLabel } from "../BranchToolbar.logic";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const THIS_DEVICE_VALUE = "this-device";
const selectDefaultEnvironmentId = (settings: ClientSettings) => settings.defaultEnvironmentId;

/**
 * The "Default machine" row. `null` (this device) is the primary environment,
 * so the list offers this device once and then every other known machine.
 */
export function DefaultEnvironmentSettingsRow() {
  const savedEnvironmentId = useClientSettings(selectDefaultEnvironmentId);
  const { environments } = useEnvironments();
  const machines = environments
    .filter((environment) => environment.entry.target._tag !== "PrimaryConnectionTarget")
    .map((environment) => ({
      environmentId: environment.environmentId,
      label: resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId: environment.environmentId,
        runtimeLabel: environment.label,
      }),
    }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
  const savedMachine =
    savedEnvironmentId === null
      ? null
      : (machines.find((machine) => machine.environmentId === savedEnvironmentId) ?? null);
  const selectedLabel =
    savedEnvironmentId === null ? "This device" : (savedMachine?.label ?? "Unavailable machine");

  return (
    <SettingsRow
      {...searchableSetting("default-machine")}
      description="Where new projects and threads without a project start."
      resetAction={
        savedEnvironmentId !== null ? (
          <SettingResetButton
            label="default machine"
            onClick={() => void updateClientSettings({ defaultEnvironmentId: null })}
          />
        ) : null
      }
      control={
        <Select
          value={savedEnvironmentId ?? THIS_DEVICE_VALUE}
          onValueChange={(value) => {
            if (value === THIS_DEVICE_VALUE) {
              void updateClientSettings({ defaultEnvironmentId: null });
              return;
            }
            const machine = machines.find((candidate) => candidate.environmentId === value);
            if (machine) void updateClientSettings({ defaultEnvironmentId: machine.environmentId });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Default machine">
            <SelectValue>{selectedLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value={THIS_DEVICE_VALUE}>
              This device
            </SelectItem>
            {machines.map((machine) => (
              <SelectItem hideIndicator key={machine.environmentId} value={machine.environmentId}>
                {machine.label}
              </SelectItem>
            ))}
            {savedEnvironmentId !== null && savedMachine === null ? (
              <SelectItem hideIndicator disabled value={savedEnvironmentId}>
                Unavailable machine
              </SelectItem>
            ) : null}
          </SelectPopup>
        </Select>
      }
    />
  );
}
