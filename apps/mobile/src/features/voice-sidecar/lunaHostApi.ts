import { File, UploadType } from "expo-file-system";

/**
 * Client for the standalone Luna voice host, a small Bun service that runs on
 * a Linux box next to a Codex subscription (repo: ~/code/luna-host on that
 * machine). It is deliberately independent of the T3 server and protocol:
 * mobile hands it a completed response, talks to Luna through it, and sends
 * the chosen reply back to the source thread over the normal T3 outbox.
 */

export type LunaReasoningEffort = "low" | "medium" | "high";
export type LunaSynopsisSentences = 1 | 2 | 3;

export interface LunaSessionPreferences {
  readonly reasoningEffort: LunaReasoningEffort;
  readonly synopsisSentences: LunaSynopsisSentences;
}

export type LunaServiceStatus = "ready" | "not-configured";

export interface LunaMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly status: "complete";
  readonly hasRecording: boolean;
  readonly hasSpeech: boolean;
  readonly createdAt: string;
}

export interface LunaSession {
  readonly id: string;
  readonly source: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly messageId: string;
  };
  readonly status: "ready" | "waiting-for-luna" | "error";
  readonly lastError: string | null;
  readonly preferences: LunaSessionPreferences;
  readonly availability: {
    readonly luna: LunaServiceStatus;
    readonly transcription: LunaServiceStatus;
    readonly synthesis: LunaServiceStatus;
  };
  readonly messages: ReadonlyArray<LunaMessage>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LunaDictionaryEntry {
  readonly id: string;
  readonly source: "learned" | "wispr";
  readonly kind: "term" | "correction";
  readonly phrase: string;
  readonly replacement: string | null;
  readonly createdAt: string;
}

export interface LunaDictionarySnapshot {
  readonly entries: ReadonlyArray<LunaDictionaryEntry>;
  readonly wispr: {
    readonly status: "disabled" | "ready" | "unavailable" | "never-synced";
    readonly lastSyncedAt: string | null;
    readonly vocabularyCount: number;
    readonly correctionCount: number;
  };
}

export interface LunaSnapshot {
  readonly session: LunaSession;
  readonly dictionary: LunaDictionarySnapshot;
}

export interface LunaCapabilities {
  readonly service: string;
  readonly version: number;
  readonly availability: LunaSession["availability"];
  readonly defaults: LunaSessionPreferences;
}

export interface LunaHostRedactedConfig {
  readonly openaiApiKeyConfigured: boolean;
  readonly kokoro: {
    readonly url: string;
    readonly voice: string;
    readonly responseFormat: "wav" | "mp3";
    readonly tokenConfigured: boolean;
  };
  readonly wispr: { readonly enabled: boolean; readonly sshHost: string };
  readonly defaults: LunaSessionPreferences;
  readonly recordingRetentionDays: number;
}

export interface LunaHostConfigPatch {
  readonly openaiApiKey?: string;
  readonly kokoro?: Partial<LunaHostRedactedConfig["kokoro"]> & { readonly token?: string };
  readonly wispr?: Partial<LunaHostRedactedConfig["wispr"]>;
  readonly defaults?: Partial<LunaSessionPreferences>;
  readonly recordingRetentionDays?: number;
}

export interface VoiceSidecarRecordingCapture {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: `audio/${string}`;
  readonly sizeBytes: number;
}

export function normalizeLunaHostUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.origin === "null" ? null : `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

async function parseError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return new Error(body?.error?.message ?? `The Luna voice host returned HTTP ${response.status}.`);
}

export class LunaHostClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init?.headers,
        },
      });
    } catch {
      throw new Error("Could not reach the Luna voice host. Check Tailscale and the host URL.");
    }
    if (!response.ok) throw await parseError(response);
    return (await response.json()) as T;
  }

  capabilities(): Promise<LunaCapabilities> {
    return this.#request("/v1/capabilities");
  }

  getConfig(): Promise<LunaHostRedactedConfig> {
    return this.#request("/v1/config");
  }

  updateConfig(patch: LunaHostConfigPatch): Promise<LunaHostRedactedConfig> {
    return this.#request("/v1/config", { method: "PUT", body: JSON.stringify(patch) });
  }

  openSession(input: {
    readonly source: LunaSession["source"];
    readonly sourceText: string;
  }): Promise<LunaSnapshot> {
    return this.#request("/v1/sessions", { method: "POST", body: JSON.stringify(input) });
  }

  getSnapshot(sessionId: string): Promise<LunaSnapshot> {
    return this.#request(`/v1/sessions/${sessionId}`);
  }

  askText(sessionId: string, commandId: string, text: string): Promise<LunaSnapshot> {
    return this.#request(`/v1/sessions/${sessionId}/ask-text`, {
      method: "POST",
      body: JSON.stringify({ commandId, text }),
    });
  }

  /** Uploads the recording and returns once transcription lands; Luna answers async. */
  async askRecording(
    sessionId: string,
    commandId: string,
    capture: VoiceSidecarRecordingCapture,
    language?: string,
  ): Promise<{ readonly text: string }> {
    const result = await new File(capture.uri).upload(
      `${this.baseUrl}/v1/sessions/${sessionId}/ask-recording`,
      {
        httpMethod: "POST",
        uploadType: UploadType.MULTIPART,
        fieldName: "audio",
        mimeType: capture.mimeType,
        parameters: { commandId, ...(language === undefined ? {} : { language }) },
        headers: { Authorization: `Bearer ${this.token}` },
      },
    );
    if (result.status < 200 || result.status >= 300) {
      let message = `The recording upload failed (${result.status}).`;
      try {
        const parsed = JSON.parse(result.body) as { error?: { message?: string } };
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // Keep the status-based message.
      }
      throw new Error(message);
    }
    return JSON.parse(result.body) as { text: string };
  }

  setPreferences(
    sessionId: string,
    commandId: string,
    preferences: LunaSessionPreferences,
  ): Promise<LunaSnapshot> {
    return this.#request(`/v1/sessions/${sessionId}/preferences`, {
      method: "POST",
      body: JSON.stringify({ commandId, preferences }),
    });
  }

  teach(sessionId: string, messageId: string, correctedText: string): Promise<LunaSnapshot> {
    return this.#request(`/v1/sessions/${sessionId}/messages/${messageId}/teach`, {
      method: "POST",
      body: JSON.stringify({ correctedText }),
    });
  }

  upsertDictionaryEntry(input: {
    readonly entryId?: string;
    readonly kind: "term" | "correction";
    readonly phrase: string;
    readonly replacement?: string;
  }): Promise<LunaDictionarySnapshot> {
    return this.#request("/v1/dictionary/entries", { method: "POST", body: JSON.stringify(input) });
  }

  deleteDictionaryEntry(entryId: string): Promise<LunaDictionarySnapshot> {
    return this.#request(`/v1/dictionary/entries/${entryId}`, { method: "DELETE" });
  }

  syncWispr(): Promise<LunaDictionarySnapshot> {
    return this.#request("/v1/dictionary/sync-wispr", { method: "POST" });
  }

  async fetchSpeech(
    sessionId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }> {
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/v1/sessions/${sessionId}/messages/${messageId}/speech`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("Could not reach the Luna voice host for audio.");
    }
    if (!response.ok) throw await parseError(response);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ?? "audio/wav",
    };
  }

  /** Direct playback URL for a stored user recording. Token travels as a query param. */
  recordingUrl(sessionId: string, messageId: string): string {
    return `${this.baseUrl}/v1/sessions/${sessionId}/messages/${messageId}/recording?token=${encodeURIComponent(this.token)}`;
  }
}
