import { VOICE_SIDECAR_MEMO_PATH, type VoiceMemoReply } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  readVoiceMemoResponse,
  retryWhileOffline,
  VoiceMemoOffline,
  VoiceMemoRejected,
  type VoiceMemoRecording,
  type VoiceMemoRequestError,
} from "./voiceMemoState";

/**
 * The sidecar holds a memo request open until the reply is ready, which can
 * take about two minutes. On iOS this becomes the request's idle timeout, so
 * it must outlast that wait.
 */
const REQUEST_TIMEOUT_MS = 150_000;

interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly body?: Uint8Array;
  readonly contentType?: string;
  readonly responseType: "arraybuffer" | "text";
  /** Called once the whole body has gone out. */
  readonly onUploaded?: () => void;
}

/**
 * One request through React Native's XMLHttpRequest. It reports upload
 * progress and takes a per-request timeout, which `fetch` cannot. A byte array
 * body goes to the native networking module as base64 and leaves the phone as
 * raw bytes. Network errors and timeouts fail with `VoiceMemoOffline`;
 * interrupting the effect aborts the request.
 */
function httpRequest(
  request: HttpRequest,
): Effect.Effect<{ readonly status: number; readonly body: unknown }, VoiceMemoOffline> {
  return Effect.callback<{ readonly status: number; readonly body: unknown }, VoiceMemoOffline>(
    (resume) => {
      const xhr = new XMLHttpRequest();
      xhr.open(request.method, request.url);
      xhr.responseType = request.responseType;
      xhr.timeout = REQUEST_TIMEOUT_MS;
      if (request.contentType !== undefined) {
        xhr.setRequestHeader("Content-Type", request.contentType);
      }
      const { onUploaded } = request;
      if (onUploaded !== undefined) {
        let uploaded = false;
        xhr.upload.addEventListener("progress", (event) => {
          if (uploaded || event.loaded < event.total) return;
          uploaded = true;
          onUploaded();
        });
      }
      const offline = () => resume(Effect.fail(new VoiceMemoOffline()));
      xhr.addEventListener("error", offline);
      xhr.addEventListener("timeout", offline);
      xhr.addEventListener("load", () => {
        // A dropped connection can surface as a load with status 0.
        if (xhr.status === 0) {
          offline();
          return;
        }
        resume(Effect.succeed({ status: xhr.status, body: xhr.response }));
      });
      xhr.send(request.body ?? null);
      return Effect.sync(() => xhr.abort());
    },
  );
}

/**
 * Sends a recording and waits for the spoken reply's details. Every attempt
 * resends the same memo id and bytes, so the server runs the memo once however
 * often the connection drops.
 */
export function submitVoiceMemo(input: {
  readonly baseUrl: string;
  readonly memo: VoiceMemoRecording;
  readonly readRecording: () => Promise<Uint8Array>;
  readonly onUploaded: () => void;
  readonly onRetrying: () => void;
}): Effect.Effect<VoiceMemoReply, VoiceMemoRequestError> {
  const { memo } = input;
  const query = new URLSearchParams({ memoId: memo.id });
  if (memo.focusThreadId !== null) query.set("focusThreadId", memo.focusThreadId);
  const url = `${input.baseUrl}${VOICE_SIDECAR_MEMO_PATH}?${query.toString()}`;

  return Effect.tryPromise({
    try: input.readRecording,
    catch: () => new VoiceMemoRejected({ message: "The recording could not be read." }),
  }).pipe(
    Effect.flatMap((body) =>
      retryWhileOffline(
        httpRequest({
          method: "POST",
          url,
          body,
          contentType: "audio/mp4",
          responseType: "text",
          onUploaded: input.onUploaded,
        }).pipe(
          Effect.flatMap((response) =>
            readVoiceMemoResponse(
              memo.id,
              response.status,
              typeof response.body === "string" ? response.body : "",
            ),
          ),
        ),
        input.onRetrying,
      ),
    ),
  );
}

function readAudioResponse(
  status: number,
  body: unknown,
): Effect.Effect<Uint8Array, VoiceMemoRequestError> {
  if (status === 503) return Effect.fail(new VoiceMemoOffline());
  if (status < 200 || status >= 300) {
    return Effect.fail(
      new VoiceMemoRejected({
        message:
          status === 404
            ? "The reply audio is no longer on the server."
            : `The reply audio could not be downloaded (status ${status}).`,
      }),
    );
  }
  // A body cut off mid-transfer is a dropped connection, not a bad reply.
  return body instanceof ArrayBuffer
    ? Effect.succeed(new Uint8Array(body))
    : Effect.fail(new VoiceMemoOffline());
}

/**
 * Downloads the reply audio and hands its bytes to `save`. The sidecar keeps
 * the audio for about an hour, so a missing file is final.
 */
export function downloadVoiceMemoReply(input: {
  readonly baseUrl: string;
  readonly reply: VoiceMemoReply;
  readonly save: (bytes: Uint8Array) => Promise<void>;
  readonly onRetrying: () => void;
}): Effect.Effect<void, VoiceMemoRequestError> {
  const download = httpRequest({
    method: "GET",
    url: `${input.baseUrl}${input.reply.audioPath}`,
    responseType: "arraybuffer",
  }).pipe(Effect.flatMap(({ status, body }) => readAudioResponse(status, body)));
  return retryWhileOffline(download, input.onRetrying).pipe(
    Effect.flatMap((bytes) =>
      Effect.tryPromise({
        try: () => input.save(bytes),
        catch: () => new VoiceMemoRejected({ message: "The reply audio could not be saved." }),
      }),
    ),
  );
}
