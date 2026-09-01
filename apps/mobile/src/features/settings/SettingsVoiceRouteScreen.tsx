import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useLunaHost } from "../../state/voice-sidecar-host";
import type {
  LunaHostConfigPatch,
  LunaHostRedactedConfig,
  LunaReasoningEffort,
  LunaSynopsisSentences,
} from "../voice-sidecar/lunaHostApi";
import { SettingsSection } from "./components/SettingsSection";
import { clampRecordingRetentionDays } from "./voiceSettingsPresentation";

function RowShell(props: {
  readonly label: string;
  readonly subtitle?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <View className="flex-row items-center gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
      <View className="min-w-0 flex-1">
        <Text className="text-base text-foreground">{props.label}</Text>
        {props.subtitle ? (
          <Text className="mt-0.5 text-xs leading-normal text-foreground-muted">
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}

function ToggleRow(props: {
  readonly label: string;
  readonly subtitle?: string;
  readonly value: boolean;
  readonly disabled?: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <RowShell label={props.label} subtitle={props.subtitle}>
      <ThemedSwitch
        disabled={props.disabled}
        value={props.value}
        onValueChange={props.onValueChange}
      />
    </RowShell>
  );
}

function SegmentedRow<T extends string | number>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly disabled?: boolean;
  readonly onChange: (value: T) => void;
}) {
  return (
    <RowShell label={props.label}>
      <View className="flex-row rounded-xl bg-subtle p-1">
        {props.options.map((option) => {
          const selected = option.value === props.value;
          return (
            <Pressable
              key={String(option.value)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              disabled={props.disabled}
              className={
                selected
                  ? "min-h-8 min-w-10 items-center justify-center rounded-lg bg-card px-2.5"
                  : "min-h-8 min-w-10 items-center justify-center rounded-lg px-2.5"
              }
              onPress={() => props.onChange(option.value)}
            >
              <Text
                className={
                  selected
                    ? "font-t3-bold text-xs text-foreground"
                    : "font-t3-medium text-xs text-foreground-muted"
                }
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </RowShell>
  );
}

function EditableRow(props: {
  readonly label: string;
  readonly subtitle?: string;
  readonly value: string;
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly secure?: boolean;
  readonly configured?: boolean;
  readonly keyboardType?: "default" | "number-pad" | "url";
  readonly onSave: (value: string) => Promise<boolean>;
  readonly onClear?: () => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(props.secure ? "" : props.value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.secure) setDraft(props.value);
  }, [props.secure, props.value]);

  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && (props.secure || trimmed !== props.value.trim());
  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      if (await props.onSave(trimmed)) {
        if (props.secure) setDraft("");
      }
    } finally {
      setSaving(false);
    }
  };
  const clear = async () => {
    if (!props.onClear || saving) return;
    setSaving(true);
    try {
      if (await props.onClear()) setDraft("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View className="gap-2 border-b border-border px-4 py-3.5 last:border-b-0">
      <View>
        <Text className="text-base text-foreground">{props.label}</Text>
        {props.subtitle ? (
          <Text className="mt-0.5 text-xs leading-normal text-foreground-muted">
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      <View className="flex-row items-center gap-2">
        <TextInput
          accessibilityLabel={props.label}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!props.disabled && !saving}
          keyboardType={props.keyboardType}
          placeholder={props.configured && props.secure ? "Stored secret" : props.placeholder}
          secureTextEntry={props.secure}
          value={draft}
          className="min-h-11 min-w-0 flex-1 rounded-xl bg-subtle px-3 text-sm text-foreground"
          onChangeText={setDraft}
          onSubmitEditing={() => void save()}
        />
        <Pressable
          accessibilityRole="button"
          disabled={!canSave || props.disabled || saving}
          className="min-h-11 items-center justify-center rounded-xl bg-foreground px-3.5 disabled:opacity-40"
          onPress={() => void save()}
        >
          {saving ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text className="font-t3-bold text-xs text-sheet">Save</Text>
          )}
        </Pressable>
        {props.configured && props.onClear ? (
          <Pressable
            accessibilityRole="button"
            disabled={props.disabled || saving}
            className="min-h-11 items-center justify-center rounded-xl bg-subtle px-3 disabled:opacity-40"
            onPress={() => void clear()}
          >
            <Text className="font-t3-bold text-xs text-foreground">Clear</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

type HostProbe =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "connected"; readonly config: LunaHostRedactedConfig }
  | { readonly status: "error"; readonly message: string };

export function SettingsVoiceRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const lunaHost = useLunaHost();
  const client = lunaHost.client;
  const [probe, setProbe] = useState<HostProbe>({ status: "idle" });
  const [probeAttempt, setProbeAttempt] = useState(0);

  useEffect(() => {
    if (client === null) {
      setProbe({ status: "idle" });
      return;
    }
    let cancelled = false;
    setProbe({ status: "loading" });
    client
      .getConfig()
      .then((config) => {
        if (!cancelled) setProbe({ status: "connected", config });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProbe({
          status: "error",
          message:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Could not reach the Luna voice host.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [client, probeAttempt]);

  const patchHostConfig = useCallback(
    async (patch: LunaHostConfigPatch): Promise<boolean> => {
      if (client === null) return false;
      try {
        const config = await client.updateConfig(patch);
        setProbe({ status: "connected", config });
        return true;
      } catch (error) {
        Alert.alert(
          "Could not save Voice & Luna settings",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The voice host rejected this setting.",
        );
        return false;
      }
    },
    [client],
  );

  const hostConfig = probe.status === "connected" ? probe.config : null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Voice & Luna" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="rounded-[20px] border border-border bg-card px-4 py-4">
          <Text className="text-sm leading-normal text-foreground-muted">
            Luna runs on a standalone voice host on your Linux server, separate from every T3
            server. Start it there and copy the URL and token it prints. Luna uses the host's Codex
            subscription; only transcription uses the OpenAI API.
          </Text>
        </View>

        <SettingsSection title="Voice host" card>
          <EditableRow
            label="Host URL"
            subtitle="The tailnet HTTPS address of the Luna voice host."
            value={preferences?.lunaHostUrl ?? ""}
            placeholder="https://stl-wsl.tailnet.ts.net:9456"
            keyboardType="url"
            disabled={preferences === null}
            onSave={(lunaHostUrl) => {
              savePreferences({ lunaHostUrl });
              return Promise.resolve(true);
            }}
          />
          <EditableRow
            label="Access token"
            subtitle="Printed by the voice host when it starts."
            value=""
            placeholder="Token"
            secure
            configured={(preferences?.lunaHostToken?.trim().length ?? 0) > 0}
            disabled={preferences === null}
            onSave={(lunaHostToken) => {
              savePreferences({ lunaHostToken });
              return Promise.resolve(true);
            }}
          />
          <ToggleRow
            label="Enable Luna"
            subtitle="Shows the waveform button on completed responses."
            value={preferences?.lunaEnabled ?? true}
            disabled={preferences === null || client === null}
            onValueChange={(lunaEnabled) => savePreferences({ lunaEnabled })}
          />
        </SettingsSection>

        {client === null ? (
          <View className="rounded-[20px] border border-border bg-card px-4 py-4">
            <Text className="font-t3-bold text-sm text-foreground">Voice host required</Text>
            <Text className="mt-1 text-sm leading-normal text-foreground-muted">
              Enter the host URL and token above. The host runs independently of T3, so your desktop
              and server installs stay on normal updates.
            </Text>
          </View>
        ) : probe.status === "loading" || probe.status === "idle" ? (
          <View className="flex-row items-center gap-3 rounded-[20px] border border-border bg-card px-4 py-4">
            <ActivityIndicator size="small" />
            <Text className="text-sm text-foreground-muted">Connecting to the voice host…</Text>
          </View>
        ) : probe.status === "error" ? (
          <View className="gap-3 rounded-[20px] border border-border bg-card px-4 py-4">
            <Text className="font-t3-bold text-sm text-foreground">Voice host unreachable</Text>
            <Text className="text-sm leading-normal text-foreground-muted">{probe.message}</Text>
            <Pressable
              accessibilityRole="button"
              className="min-h-11 items-center justify-center self-start rounded-full border border-border bg-subtle px-5 active:opacity-70"
              onPress={() => setProbeAttempt((attempt) => attempt + 1)}
            >
              <Text className="font-t3-bold text-sm text-foreground">Retry</Text>
            </Pressable>
          </View>
        ) : hostConfig ? (
          <>
            <SettingsSection title="Luna defaults" card>
              <SegmentedRow<LunaReasoningEffort>
                label="Reasoning"
                value={hostConfig.defaults.reasoningEffort}
                options={[
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" },
                ]}
                onChange={(reasoningEffort) =>
                  void patchHostConfig({ defaults: { reasoningEffort } })
                }
              />
              <SegmentedRow<LunaSynopsisSentences>
                label="Synopsis length"
                value={hostConfig.defaults.synopsisSentences}
                options={[
                  { value: 1, label: "1" },
                  { value: 2, label: "2" },
                  { value: 3, label: "3" },
                ]}
                onChange={(synopsisSentences) =>
                  void patchHostConfig({ defaults: { synopsisSentences } })
                }
              />
            </SettingsSection>

            <SettingsSection title="Transcription" card>
              <EditableRow
                label="OpenAI API key"
                subtitle="Stored on the voice host and used only for gpt-transcribe."
                value=""
                placeholder="sk-…"
                secure
                configured={hostConfig.openaiApiKeyConfigured}
                onSave={(openaiApiKey) => patchHostConfig({ openaiApiKey })}
                onClear={() => patchHostConfig({ openaiApiKey: "" })}
              />
            </SettingsSection>

            <SettingsSection title="Kokoro speech" card>
              <EditableRow
                label="Endpoint URL"
                subtitle="OpenAI-compatible /v1/audio/speech endpoint the host calls."
                value={hostConfig.kokoro.url}
                placeholder="http://127.0.0.1:8890/v1/audio/speech"
                keyboardType="url"
                onSave={(url) => patchHostConfig({ kokoro: { url } })}
              />
              <EditableRow
                label="Voice"
                value={hostConfig.kokoro.voice}
                placeholder="af_heart"
                onSave={(voice) => patchHostConfig({ kokoro: { voice } })}
              />
            </SettingsSection>

            <SettingsSection title="Dictionary and recordings" card>
              <ToggleRow
                label="Wispr Flow dictionary"
                subtitle="Imports vocabulary and corrections over SSH. Snippets are skipped."
                value={hostConfig.wispr.enabled}
                onValueChange={(enabled) => void patchHostConfig({ wispr: { enabled } })}
              />
              <EditableRow
                label="Wispr SSH host"
                subtitle="SSH host the voice host uses to read the Mac dictionary."
                value={hostConfig.wispr.sshHost}
                placeholder="mac"
                disabled={!hostConfig.wispr.enabled}
                onSave={(sshHost) => patchHostConfig({ wispr: { sshHost } })}
              />
              <EditableRow
                label="Recording retention"
                subtitle="Days before the voice host deletes stored audio."
                value={String(hostConfig.recordingRetentionDays)}
                placeholder="30"
                keyboardType="number-pad"
                onSave={(value) => {
                  const recordingRetentionDays = clampRecordingRetentionDays(value);
                  if (recordingRetentionDays === null) {
                    Alert.alert("Invalid retention", "Enter a whole number from 1 through 365.");
                    return Promise.resolve(false);
                  }
                  return patchHostConfig({ recordingRetentionDays });
                }}
              />
            </SettingsSection>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
