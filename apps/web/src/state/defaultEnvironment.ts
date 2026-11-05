import type { ClientSettings, EnvironmentId } from "@t3tools/contracts";

import { getClientSettings, useClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readPrimaryEnvironmentId,
  useConnectedEnvironmentIds,
  usePrimaryEnvironmentId,
} from "./environments";
import { environmentSummaries } from "./presentation";

/**
 * The saved default machine while it is connected, otherwise this device.
 * A machine that is offline or no longer known never strands a new project
 * or thread on it.
 */
export function resolveDefaultEnvironmentId(input: {
  readonly savedEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}): EnvironmentId | null {
  return input.savedEnvironmentId !== null &&
    input.connectedEnvironmentIds.includes(input.savedEnvironmentId)
    ? input.savedEnvironmentId
    : input.primaryEnvironmentId;
}

const selectDefaultEnvironmentId = (settings: ClientSettings) => settings.defaultEnvironmentId;

/** Where new projects and threads without a project start. */
export function useDefaultEnvironmentId(): EnvironmentId | null {
  return resolveDefaultEnvironmentId({
    savedEnvironmentId: useClientSettings(selectDefaultEnvironmentId),
    primaryEnvironmentId: usePrimaryEnvironmentId(),
    connectedEnvironmentIds: useConnectedEnvironmentIds(),
  });
}

/** `useDefaultEnvironmentId` for code that runs outside React, such as shortcuts. */
export function readDefaultEnvironmentId(): EnvironmentId | null {
  return resolveDefaultEnvironmentId({
    savedEnvironmentId: getClientSettings().defaultEnvironmentId,
    primaryEnvironmentId: readPrimaryEnvironmentId(),
    connectedEnvironmentIds: appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom),
  });
}
