import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { LunaHostClient, normalizeLunaHostUrl } from "../features/voice-sidecar/lunaHostApi";
import { mobilePreferencesAtom } from "./preferences";

export interface LunaHostPreferences {
  readonly lunaHostUrl?: string;
  readonly lunaHostToken?: string;
  readonly lunaEnabled?: boolean;
}

export interface LunaHost {
  /** Null until device preferences load or while no host URL is saved. */
  readonly client: LunaHostClient | null;
  readonly enabled: boolean;
  readonly isReady: boolean;
}

/**
 * The Luna voice host is a standalone service reached by URL and token from
 * device preferences. It is not a T3 environment, so availability never
 * depends on which T3 servers this phone is paired with.
 */
export function resolveLunaHost(preferences: LunaHostPreferences | null): LunaHost {
  if (preferences === null) return { client: null, enabled: false, isReady: false };
  const url = normalizeLunaHostUrl(preferences.lunaHostUrl ?? "");
  const token = preferences.lunaHostToken?.trim() ?? "";
  const configured = url !== null && token.length > 0;
  return {
    client: configured ? new LunaHostClient(url, token) : null,
    enabled: configured && (preferences.lunaEnabled ?? true),
    isReady: true,
  };
}

export function useLunaHost(): LunaHost {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  return useMemo(
    () =>
      resolveLunaHost(
        preferences === null
          ? null
          : {
              lunaHostUrl: preferences.lunaHostUrl,
              lunaHostToken: preferences.lunaHostToken,
              lunaEnabled: preferences.lunaEnabled,
            },
      ),
    [preferences],
  );
}
