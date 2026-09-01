import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { SettingsRow } from "./components/SettingsRow";
import { lunaSettingsSummary } from "./voiceSettingsPresentation";

export function VoiceSettingsEntry() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;

  return (
    <SettingsRow
      icon="waveform"
      label="Voice & Luna"
      value={lunaSettingsSummary(preferences)}
      target="SettingsVoice"
    />
  );
}
