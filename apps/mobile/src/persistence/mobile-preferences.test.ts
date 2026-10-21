import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

vi.mock("expo-secure-store", () => ({}));

import { MobileDatabase, MobileDatabaseError, type StoredPreferencesJson } from "./mobile-database";
import { MobileSecureStorage } from "./mobile-secure-storage";
import { make, type Preferences } from "./mobile-preferences";

function storage(initial?: unknown) {
  let row: StoredPreferencesJson | null =
    initial === undefined ? null : { payload: JSON.stringify(initial), updatedAt: 1 };
  let unavailable = false;
  const secureItems = new Map<string, string>();
  const failure = new MobileDatabaseError({
    operation: "open",
    cause: new Error("SQLite unavailable"),
  });
  const database = MobileDatabase.of({
    loadPreferencesJson: Effect.suspend(() =>
      unavailable
        ? Effect.fail(failure)
        : Effect.succeed(row === null ? Option.none<StoredPreferencesJson>() : Option.some(row)),
    ),
    savePreferencesJson: (payload, updatedAt) =>
      Effect.suspend(() =>
        unavailable
          ? Effect.fail(failure)
          : Effect.sync(() => {
              row = { payload, updatedAt };
            }),
      ),
    loadCache: () => Effect.die("Unexpected cache operation"),
    listCache: () => Effect.die("Unexpected cache operation"),
    saveCache: () => Effect.die("Unexpected cache operation"),
    removeCache: () => Effect.die("Unexpected cache operation"),
    clearCacheKind: () => Effect.die("Unexpected cache operation"),
    clearEnvironmentCache: () => Effect.die("Unexpected cache operation"),
    clearAllCaches: Effect.die("Unexpected cache operation"),
    inspectCaches: Effect.die("Unexpected cache operation"),
  });
  const secureStorage = MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => secureItems.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        secureItems.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        secureItems.delete(key);
      }),
  });
  const createStore = () =>
    make().pipe(
      Effect.provideService(MobileDatabase, database),
      Effect.provideService(MobileSecureStorage, secureStorage),
    );
  return {
    createStore,
    secureItems,
    persisted: () => row,
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
  };
}

describe("mobile startup audio preferences persistence", () => {
  it.effect.each(["ringing", "jazz", "silence"] as const)(
    "persists %s across store recreation and unrelated updates",
    (choice) =>
      Effect.gen(function* () {
        const backing = storage({ baseFontSize: 17 });
        const first = yield* backing.createStore();
        expect(yield* first.savePatch({ voiceStartupAudio: choice })).toEqual({
          baseFontSize: 17,
          voiceStartupAudio: choice,
        });
        expect(JSON.parse(backing.persisted()!.payload)).toEqual({
          baseFontSize: 17,
          voiceStartupAudio: choice,
        });
        const reopened = yield* backing.createStore();
        expect(yield* reopened.load).toEqual({ baseFontSize: 17, voiceStartupAudio: choice });
        yield* reopened.savePatch({ baseFontSize: 19 });
        const third = yield* backing.createStore();
        expect(yield* third.load).toEqual({ baseFontSize: 19, voiceStartupAudio: choice });
      }),
  );

  it.effect.each(["ringing", "jazz", "silence"] as const)(
    "recovers %s from secure storage after SQLite returns",
    (choice) =>
      Effect.gen(function* () {
        const backing = storage();
        backing.setUnavailable(true);
        const first = yield* backing.createStore();
        yield* first.savePatch({ voiceStartupAudio: choice });
        expect(backing.secureItems.size).toBe(1);
        expect(backing.persisted()).toBeNull();
        const fallback = yield* backing.createStore();
        expect(yield* fallback.load).toEqual({ voiceStartupAudio: choice });
        backing.setUnavailable(false);
        const recovered = yield* backing.createStore();
        expect(yield* recovered.load).toEqual({ voiceStartupAudio: choice });
        expect(JSON.parse(backing.persisted()!.payload)).toEqual({ voiceStartupAudio: choice });
        expect(backing.secureItems.size).toBe(0);
      }),
  );

  it.effect.each(["unknown", "RINGING", "", null, 1, true, {}, ["jazz"]])(
    "drops unsupported persisted selection %j without losing other preferences",
    (invalid) =>
      Effect.gen(function* () {
        const backing = storage({ voiceStartupAudio: invalid, baseFontSize: 18 });
        const store = yield* backing.createStore();
        expect(yield* store.load).toEqual({ baseFontSize: 18 });
        yield* store.savePatch({ codeWordBreak: true });
        expect(JSON.parse(backing.persisted()!.payload)).toEqual({
          baseFontSize: 18,
          codeWordBreak: true,
        });
      }),
  );

  it.effect("keeps old preference records valid when startup audio is absent", () =>
    Effect.gen(function* () {
      const backing = storage({
        baseFontSize: 16,
        liveActivitiesEnabled: false,
      } satisfies Preferences);
      const store = yield* backing.createStore();
      expect(yield* store.load).toEqual({ baseFontSize: 16, liveActivitiesEnabled: false });
    }),
  );
});
