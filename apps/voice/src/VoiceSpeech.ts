import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { VoiceSessionError } from "./VoiceSessionService.ts";

export interface VoiceSpeechConfig {
  /** The ffmpeg binary. */
  readonly ffmpegCommand: string;
  /** Sotto server origin, e.g. `http://100.115.179.3:8391`. */
  readonly sottoUrl: string;
  readonly sottoToken: string;
  /** Kokoro server origin serving `POST /v1/audio/speech`. */
  readonly kokoroUrl: string;
  readonly kokoroVoice: string;
}

export interface VoiceSpeechShape {
  /**
   * Transcribes one recording in any container ffmpeg reads. `requestId`
   * makes a retried upload reuse Sotto's record instead of starting another.
   */
  readonly transcribe: (input: {
    readonly requestId: string;
    readonly audio: Uint8Array;
  }) => Effect.Effect<string, VoiceSessionError>;
  /** Speaks `text` as AAC in an m4a container. */
  readonly synthesize: (text: string) => Effect.Effect<Uint8Array, VoiceSessionError>;
}

/**
 * Speech for voice memos, all local and free: Sotto (whisper.cpp plus
 * Tanner's dictionary and cleanup) transcribes, Kokoro on the GPU speaks, and
 * ffmpeg converts between the phone's m4a and what each one takes.
 */
export class VoiceSpeech extends Context.Service<VoiceSpeech, VoiceSpeechShape>()(
  "@t3tools/voice/VoiceSpeech",
) {}

/** Sotto takes raw float32 mono PCM at this rate. */
const SOTTO_SAMPLE_RATE = 16_000;
const SOTTO_MIN_SECONDS = 0.25;
/** Sotto refuses longer recordings; the phone sends before this. */
const SOTTO_MAX_SECONDS = 180;
const SOTTO_CHUNK_BYTES = 1_048_576;
const SOTTO_TIMEOUT = Duration.minutes(2);
/** Sotto handles one recording at a time, so a Mac dictation can hold it briefly. */
const SOTTO_BUSY_RETRIES = 60;

const SottoRecord = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  finalText: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(Schema.Unknown),
  settings: Schema.optional(
    Schema.Struct({ preferences: Schema.Struct({ keepOriginalAudio: Schema.Boolean }) }),
  ),
});

const isVoiceSessionError = Schema.is(VoiceSessionError);

/**
 * The parts of a failure safe to log. A Sotto request carries its bearer
 * token, so an HTTP error is reduced to its kind, status and URL.
 */
export const describeSpeechFailure = (cause: unknown) => {
  if (HttpClientError.isHttpClientError(cause)) {
    return {
      kind: cause.reason._tag,
      status: cause.reason._tag === "StatusCodeError" ? cause.reason.response.status : undefined,
      url: cause.reason.request.url,
    };
  }
  if (typeof cause === "string") return { kind: cause };
  return {
    kind:
      typeof cause === "object" && cause !== null && "_tag" in cause
        ? String(cause._tag)
        : typeof cause,
  };
};

const isSottoBusy = (error: HttpClientError.HttpClientError) =>
  error.reason._tag === "StatusCodeError" &&
  (error.reason.response.status === 409 || error.reason.response.status === 503);

/** Trims PCM to Sotto's duration limit, keeping whole float32 frames. */
export const clampSottoPcm = (pcm: Uint8Array): Uint8Array => {
  const maxBytes = SOTTO_MAX_SECONDS * SOTTO_SAMPLE_RATE * 4 - 4 * SOTTO_SAMPLE_RATE;
  const wholeFrames = pcm.length - (pcm.length % 4);
  return pcm.subarray(0, Math.min(wholeFrames, maxBytes));
};

export const make = Effect.fn("voice/VoiceSpeech.make")(function* (config: VoiceSpeechConfig) {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** Runs ffmpeg from `input` bytes to an output file and returns its bytes. */
  const convert = (input: Uint8Array, inputName: string, outputName: string, args: string[]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-memo-" });
        const source = path.join(directory, inputName);
        const target = path.join(directory, outputName);
        yield* fs.writeFile(source, input);
        const exitCode = yield* spawner.exitCode(
          ChildProcess.make(
            config.ffmpegCommand,
            ["-nostdin", "-v", "error", "-i", source, ...args, target],
            { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
          ),
        );
        if (exitCode !== 0) return yield* Effect.fail(`ffmpeg exited with ${exitCode}`);
        return yield* fs.readFile(target);
      }),
    );

  const sotto = (route: string) => `${config.sottoUrl}/v1${route}`;
  const authorized = HttpClientRequest.bearerToken(config.sottoToken);

  const transcribe: VoiceSpeechShape["transcribe"] = ({ requestId, audio }) =>
    Effect.gen(function* () {
      const pcm = clampSottoPcm(
        yield* convert(audio, "memo.m4a", "memo.pcm", [
          "-ac",
          "1",
          "-ar",
          String(SOTTO_SAMPLE_RATE),
          "-f",
          "f32le",
        ]).pipe(
          Effect.mapError(
            () => new VoiceSessionError({ message: "Couldn't read that recording." }),
          ),
        ),
      );
      const frames = pcm.length / 4;
      if (frames < SOTTO_MIN_SECONDS * SOTTO_SAMPLE_RATE) {
        return yield* new VoiceSessionError({ message: "That memo was too short to hear." });
      }

      const created = yield* HttpClientRequest.post(sotto("/generations")).pipe(
        authorized,
        HttpClientRequest.bodyJsonUnsafe({
          requestID: requestId,
          device: { id: "t3-voice-sidecar", name: "T3 voice memos" },
          mode: "file",
        }),
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(SottoRecord)),
        Effect.retry({
          while: (error) => error._tag === "HttpClientError" && isSottoBusy(error),
          schedule: Schedule.spaced("1 second"),
          times: SOTTO_BUSY_RETRIES,
        }),
      );
      // A retry of a finished request gets its existing record back.
      if (created.status === "receiving") {
        const kinds = created.settings?.preferences.keepOriginalAudio
          ? (["inference", "original"] as const)
          : (["inference"] as const);
        for (const kind of kinds) {
          for (let sequence = 0; sequence * SOTTO_CHUNK_BYTES < pcm.length; sequence++) {
            const offset = sequence * SOTTO_CHUNK_BYTES;
            yield* HttpClientRequest.post(sotto(`/generations/${created.id}/audio/${kind}`)).pipe(
              authorized,
              HttpClientRequest.setUrlParams({
                sequence: String(sequence),
                sampleRate: String(SOTTO_SAMPLE_RATE),
                channels: "1",
              }),
              HttpClientRequest.bodyUint8Array(
                pcm.subarray(offset, offset + SOTTO_CHUNK_BYTES),
                "application/octet-stream",
              ),
              http.execute,
            );
          }
        }
        yield* HttpClientRequest.post(sotto(`/generations/${created.id}/finish`)).pipe(
          authorized,
          HttpClientRequest.bodyJsonUnsafe(
            kinds.length === 2
              ? { inferenceFrames: frames, originalFrames: frames }
              : { inferenceFrames: frames },
          ),
          http.execute,
        );
      }

      const record = yield* HttpClientRequest.get(sotto(`/generations/${created.id}`)).pipe(
        authorized,
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(SottoRecord)),
        Effect.repeat({
          until: (current) => ["completed", "failed", "cancelled"].includes(current.status),
          schedule: Schedule.spaced("500 millis"),
        }),
        Effect.timeoutOrElse({
          duration: SOTTO_TIMEOUT,
          orElse: () =>
            Effect.fail(new VoiceSessionError({ message: "Transcription took too long." })),
        }),
      );
      if (record.status !== "completed") {
        yield* Effect.logWarning("voice.memo.transcription-failed", {
          status: record.status,
          error: record.error,
        });
        return yield* new VoiceSessionError({ message: "Transcription failed." });
      }
      const text = record.finalText?.trim() ?? "";
      if (text === "") {
        return yield* new VoiceSessionError({ message: "I didn't catch anything in that memo." });
      }
      return text;
    }).pipe(
      Effect.catchIf(
        (error) => !isVoiceSessionError(error),
        (cause) =>
          Effect.logWarning("voice.memo.transcription-error", describeSpeechFailure(cause)).pipe(
            Effect.andThen(
              Effect.fail(new VoiceSessionError({ message: "Transcription isn't available." })),
            ),
          ),
      ),
    );

  const synthesize: VoiceSpeechShape["synthesize"] = (text) =>
    HttpClientRequest.post(`${config.kokoroUrl}/v1/audio/speech`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        model: "kokoro",
        input: text,
        voice: config.kokoroVoice,
        response_format: "wav",
        speed: 1,
      }),
      http.execute,
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.flatMap((wav) =>
        convert(new Uint8Array(wav), "reply.wav", "reply.m4a", [
          "-ac",
          "1",
          "-c:a",
          "aac",
          "-b:a",
          "48k",
          "-movflags",
          "+faststart",
        ]),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("voice.memo.speech-failed", describeSpeechFailure(cause)).pipe(
          Effect.andThen(
            Effect.fail(new VoiceSessionError({ message: "Couldn't speak the reply." })),
          ),
        ),
      ),
    );

  return VoiceSpeech.of({ transcribe, synthesize });
});

/** Needs `HttpClient`, `ChildProcessSpawner`, `FileSystem` and `Path`. */
export const layer = (config: VoiceSpeechConfig) => Layer.effect(VoiceSpeech, make(config));

/** For a sidecar without Sotto configured: every memo fails with a clear message. */
export const layerUnavailable = Layer.succeed(
  VoiceSpeech,
  VoiceSpeech.of({
    transcribe: () =>
      Effect.fail(new VoiceSessionError({ message: "Voice memos aren't set up on this server." })),
    synthesize: () =>
      Effect.fail(new VoiceSessionError({ message: "Voice memos aren't set up on this server." })),
  }),
);
