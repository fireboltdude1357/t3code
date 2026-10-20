import { type ThreadId, VOICE_SIDECAR_MEMO_PATH, type VoiceMemoReply } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { VoiceOrchestrator } from "./VoiceOrchestrator.ts";
import { VoiceSessionError } from "./VoiceSessionService.ts";
import { VoiceSpeech } from "./VoiceSpeech.ts";

export interface VoiceMemoInput {
  readonly memoId: string;
  readonly focusThreadId?: ThreadId;
  readonly audio: Uint8Array;
}

export interface VoiceMemosShape {
  /**
   * Answers one memo. The same `memoId` always gets the same reply: a retry
   * while it runs waits for it, and a retry after a failure resumes from the
   * last step that worked, so the agent never answers one memo twice.
   */
  readonly submit: (input: VoiceMemoInput) => Effect.Effect<VoiceMemoReply, VoiceSessionError>;
  /** The spoken reply of a finished memo, kept for `MEMO_RETENTION`. */
  readonly audio: (memoId: string) => Effect.Effect<Option.Option<Uint8Array>>;
}

export class VoiceMemos extends Context.Service<VoiceMemos, VoiceMemosShape>()(
  "@t3tools/voice/VoiceMemos",
) {}

export const MEMO_RETENTION = Duration.hours(1);

/** Path of a memo's reply audio, under `VOICE_SIDECAR_MEMO_PATH`. */
export const memoAudioPath = (memoId: string) =>
  `${VOICE_SIDECAR_MEMO_PATH}/${encodeURIComponent(memoId)}/audio`;

interface Done {
  readonly reply: VoiceMemoReply;
  readonly audio: Uint8Array;
}

interface MemoEntry {
  readonly createdAt: number;
  /** Steps that already succeeded, reused by a retry after a failure. */
  readonly transcript?: string;
  readonly answer?: string;
  readonly attempt: Deferred.Deferred<Done, VoiceSessionError>;
  readonly failed: boolean;
  readonly audio?: Uint8Array;
}

/** Which attempt a submit waits on, and the entry to start a new one from, if it must. */
interface Claim {
  readonly attempt: Deferred.Deferred<Done, VoiceSessionError>;
  readonly start: MemoEntry | undefined;
}

export const make = Effect.gen(function* () {
  const speech = yield* VoiceSpeech;
  const voice = yield* VoiceOrchestrator;
  const scope = yield* Effect.scope;
  const entries = yield* Ref.make<ReadonlyMap<string, MemoEntry>>(new Map());
  const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

  const update = (memoId: string, patch: Partial<MemoEntry>) =>
    Ref.update(entries, (current) => {
      const entry = current.get(memoId);
      return entry === undefined ? current : new Map(current).set(memoId, { ...entry, ...patch });
    });

  const run = (input: VoiceMemoInput, entry: MemoEntry) =>
    Effect.gen(function* () {
      const started = yield* nowMillis;
      const transcript =
        entry.transcript ??
        (yield* speech.transcribe({ requestId: input.memoId, audio: input.audio }));
      yield* update(input.memoId, { transcript });
      const heard = yield* nowMillis;
      const answer =
        entry.answer ??
        (yield* voice.memo({
          text: transcript,
          ...(input.focusThreadId === undefined ? {} : { focusThreadId: input.focusThreadId }),
        }));
      yield* update(input.memoId, { answer });
      const answered = yield* nowMillis;
      const audio = yield* speech.synthesize(answer);
      yield* update(input.memoId, { audio });
      yield* Effect.logInfo("voice.memo.answered", {
        transcribeMs: heard - started,
        agentMs: answered - heard,
        speechMs: (yield* nowMillis) - answered,
      });
      return {
        reply: {
          memoId: input.memoId,
          transcript,
          reply: answer,
          audioPath: memoAudioPath(input.memoId),
        },
        audio,
      } satisfies Done;
    });

  const submit: VoiceMemosShape["submit"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowMillis;
      const fresh = yield* Deferred.make<Done, VoiceSessionError>();
      const { attempt, start } = yield* Ref.modify(
        entries,
        (current): readonly [Claim, ReadonlyMap<string, MemoEntry>] => {
          const kept = new Map(
            [...current].filter(
              ([, entry]) => now - entry.createdAt < Duration.toMillis(MEMO_RETENTION),
            ),
          );
          const existing = kept.get(input.memoId);
          if (existing !== undefined && !existing.failed) {
            return [{ attempt: existing.attempt, start: undefined }, kept];
          }
          const entry: MemoEntry = {
            ...existing,
            createdAt: existing?.createdAt ?? now,
            attempt: fresh,
            failed: false,
          };
          return [{ attempt: fresh, start: entry }, kept.set(input.memoId, entry)];
        },
      );
      // The work runs outside the request, so a phone that drops the
      // connection can come back for the same reply.
      if (start !== undefined) {
        yield* run(input, start).pipe(
          Effect.catchDefect((defect) =>
            Effect.logError("voice.memo.defect", { defect }).pipe(
              Effect.andThen(Effect.fail(new VoiceSessionError({ message: "The memo failed." }))),
            ),
          ),
          Effect.onExit((exit) =>
            (Exit.isFailure(exit) ? update(input.memoId, { failed: true }) : Effect.void).pipe(
              Effect.andThen(Deferred.done(fresh, exit)),
            ),
          ),
          Effect.forkIn(scope),
        );
      }
      return (yield* Deferred.await(attempt)).reply;
    });

  const audio: VoiceMemosShape["audio"] = (memoId) =>
    Ref.get(entries).pipe(
      Effect.map((current) => Option.fromNullishOr(current.get(memoId)?.audio)),
    );

  return VoiceMemos.of({ submit, audio });
});

export const layer = Layer.effect(VoiceMemos, make);
