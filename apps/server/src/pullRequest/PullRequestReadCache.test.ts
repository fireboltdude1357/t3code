import * as NodeV8 from "node:v8";
import * as NodeVM from "node:vm";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PullRequestOperationError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as TestClock from "effect/testing/TestClock";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";

NodeV8.setFlagsFromString("--expose-gc");
const collectGarbage = NodeVM.runInNewContext("gc") as () => void;

const cacheLayer = (directory: string) =>
  PullRequestReadCache.make.pipe(Effect.provide(KeyValueStore.layerFileSystem(directory)));

it.layer(NodeServices.layer)("PR filesystem cache", (it) => {
  it.effect("clears in-flight reads before a new service can reuse them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-cache-" });
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cache = yield* cacheLayer(directory);
      const read = yield* cache
        .get(
          "summary",
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("old"),
          ),
          ["pr"],
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const invalidate = yield* cache
        .invalidate("pr")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(read);
      yield* Fiber.join(invalidate);
      const restarted = yield* cacheLayer(directory);
      assert.strictEqual(yield* restarted.get("summary", Effect.succeed("new"), ["pr"]), "new");
    }),
  );

  it.effect("invalidates only the changed scope across restarts and coalesces its next reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-cache-" });
      let reads = 0;
      const lookup = Effect.sync(() => String(++reads));
      const cache = yield* cacheLayer(directory);
      yield* cache.get("first", lookup, ["project", "pr-1"]);
      yield* cache.get("second", lookup, ["project", "pr-2"]);
      yield* cache.get("third", lookup, ["other-project", "pr-3"]);
      yield* cache.invalidate("pr-1");
      const restarted = yield* cacheLayer(directory);
      const answers = yield* Effect.all(
        Array.from({ length: 10 }, () => restarted.get("first", lookup, ["project", "pr-1"])),
        { concurrency: 10 },
      );
      assert.deepStrictEqual(answers, Array(10).fill("4"));
      assert.strictEqual(yield* restarted.get("second", lookup, ["project", "pr-2"]), "2");
      yield* restarted.invalidate("project");
      const again = yield* cacheLayer(directory);
      assert.strictEqual(yield* again.get("second", lookup, ["project", "pr-2"]), "5");
      assert.strictEqual(yield* again.get("third", lookup, ["other-project", "pr-3"]), "3");
      assert.strictEqual(reads, 5);
      const files = (yield* fs.readDirectory(directory)).length;
      for (let index = 0; index < 3; index++) {
        yield* again.invalidate("pr-1");
        yield* again.get("first", lookup, ["project", "pr-1"]);
      }
      assert.strictEqual((yield* fs.readDirectory(directory)).length, files);
    }),
  );

  it.effect("shares a pending refresh without blocking an unrelated cached PR", () =>
    Effect.gen(function* () {
      const cache = yield* PullRequestReadCache.make;
      yield* cache.get("first", Effect.succeed("old"), ["pr-1"]);
      yield* cache.get("second", Effect.succeed("warm"), ["pr-2"]);
      yield* cache.invalidate("pr-1");
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reads = 0;
      const refresh = cache.get(
        "first",
        Effect.gen(function* () {
          reads++;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return "fresh";
        }),
        ["pr-1"],
      );
      const pending = yield* Effect.all(
        Array.from({ length: 10 }, () => refresh),
        {
          concurrency: 10,
        },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      assert.strictEqual(yield* cache.get("second", Effect.die("cache miss"), ["pr-2"]), "warm");
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(pending), Array(10).fill("fresh"));
      assert.strictEqual(reads, 1);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("does not persist failed GitHub reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-cache-" });
      const cache = yield* cacheLayer(directory);
      const error = new PullRequestOperationError({ operation: "summary", detail: "unavailable" });
      yield* cache.get("summary", Effect.fail(error)).pipe(Effect.flip);
      const restarted = yield* cacheLayer(directory);
      assert.strictEqual(yield* restarted.get("summary", Effect.succeed("recovered")), "recovered");
    }),
  );

  it.effect("resumes caching after a failed scope read", () =>
    Effect.gen(function* () {
      const backing = yield* KeyValueStore.KeyValueStore;
      let fail = true;
      let reads = 0;
      const cache = yield* PullRequestReadCache.make.pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, {
          ...backing,
          get: (key) =>
            Effect.suspend(() => {
              if (!fail) return backing.get(key);
              fail = false;
              return Effect.fail(
                new KeyValueStore.KeyValueStoreError({ method: "get", message: "unavailable" }),
              );
            }),
        }),
      );
      const read = cache.get(
        "summary",
        Effect.sync(() => String(++reads)),
        ["pr"],
      );
      assert.strictEqual(yield* read, "1");
      assert.strictEqual(yield* read, "2");
      assert.strictEqual(yield* read, "2");
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("does not keep a caller's data alive after its reads and invalidations", () =>
    Effect.gen(function* () {
      const cache = yield* PullRequestReadCache.make;
      const sweeps: Array<WeakRef<object>> = [];
      // Like a sync sweep: an Effect.fn made per run that closes over that run's data.
      const sweep = Effect.fn("sweep")(function* (index: number) {
        const groups = new Map<string, number>(
          Array.from({ length: 1_000 }, (_, id) => [`group-${id}`, id]),
        );
        sweeps.push(new WeakRef(groups));
        const read = Effect.fn("read")(function* (pr: string) {
          const size = groups.size;
          yield* cache.invalidate(pr);
          const answer = yield* cache.get(`${pr}-${index}`, Effect.succeed("answer"), [pr]);
          return size + answer.length;
        });
        yield* Effect.forEach(["pr-1", "pr-2"], read, { discard: true });
      });
      for (let index = 0; index < 5; index++) yield* sweep(index);
      // WeakRef targets stay alive until the current job ends, so yield before collecting.
      yield* Effect.yieldNow;
      collectGarbage();
      assert.strictEqual(sweeps.filter((sweepData) => sweepData.deref() !== undefined).length, 0);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("invalidates without waiting for a read still in flight", () =>
    Effect.gen(function* () {
      const cache = yield* PullRequestReadCache.make;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const read = yield* cache
        .get(
          "summary",
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("old"),
          ),
          ["pr"],
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);

      // The read's lookup only finishes after the invalidation, so waiting for it would deadlock.
      yield* cache.invalidate("pr");
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual(yield* Fiber.join(read), "old");
      assert.strictEqual(yield* cache.get("summary", Effect.succeed("fresh"), ["pr"]), "fresh");
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("does not cache a read that an invalidation overtook", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-cache-" });
      const cache = yield* cacheLayer(directory);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const read = yield* cache
        .get(
          "summary",
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("old"),
          ),
          ["pr"],
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* cache.invalidate("pr");
      // The old lookup finishes well after the invalidation...
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual(yield* Fiber.join(read), "old");
      // ...and the invalidation's own revision has expired by now.
      yield* TestClock.adjust("31 seconds");

      assert.strictEqual(yield* cache.get("summary", Effect.succeed("fresh"), ["pr"]), "fresh");
      const restarted = yield* cacheLayer(directory);
      assert.strictEqual(yield* restarted.get("summary", Effect.succeed("fresh"), ["pr"]), "fresh");
    }),
  );

  it.effect("caches a read when only another scope was invalidated meanwhile", () =>
    Effect.gen(function* () {
      const cache = yield* PullRequestReadCache.make;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const read = yield* cache
        .get(
          "summary",
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("first"),
          ),
          ["pr-a"],
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* cache.invalidate("pr-b");
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual(yield* Fiber.join(read), "first");

      assert.strictEqual(yield* cache.get("summary", Effect.succeed("second"), ["pr-a"]), "first");
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("does not cache a read that started while an invalidation was publishing", () =>
    Effect.gen(function* () {
      const backing = yield* KeyValueStore.KeyValueStore;
      const publishing = yield* Deferred.make<void>();
      const publish = yield* Deferred.make<void>();
      let pause = false;
      const cache = yield* PullRequestReadCache.make.pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, {
          ...backing,
          set: (key, value) =>
            key === "revisions" && pause
              ? Deferred.succeed(publishing, undefined).pipe(
                  Effect.andThen(Deferred.await(publish)),
                  Effect.andThen(backing.set(key, value)),
                )
              : backing.set(key, value),
        }),
      );
      pause = true;
      const invalidation = yield* cache.invalidate("pr").pipe(Effect.forkChild);
      yield* Deferred.await(publishing);
      const release = yield* Deferred.make<void>();
      const read = yield* cache
        .get("summary", Deferred.await(release).pipe(Effect.as("old")), ["pr"])
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(publish, undefined);
      yield* Fiber.join(invalidation);
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual(yield* Fiber.join(read), "old");
      yield* TestClock.adjust("31 seconds");

      assert.strictEqual(yield* cache.get("summary", Effect.succeed("fresh"), ["pr"]), "fresh");
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("does not serve a stale entry written between a refresh's removal and reload", () =>
    Effect.gen(function* () {
      const backing = yield* KeyValueStore.KeyValueStore;
      const holdWrite = yield* Deferred.make<void>();
      const written = yield* Deferred.make<void>();
      let holding = false;
      let releaseOnRemove = false;
      const cache = yield* PullRequestReadCache.make.pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, {
          ...backing,
          set: (key, value) =>
            key !== "revisions" && holding
              ? Effect.sync(() => {
                  holding = false;
                }).pipe(
                  Effect.andThen(Deferred.await(holdWrite)),
                  Effect.andThen(backing.set(key, value)),
                  Effect.andThen(Deferred.succeed(written, undefined)),
                )
              : backing.set(key, value),
          remove: (key) =>
            backing.remove(key).pipe(
              Effect.andThen(
                key !== "revisions" && releaseOnRemove
                  ? Effect.sync(() => {
                      releaseOnRemove = false;
                    }).pipe(
                      Effect.andThen(Deferred.succeed(holdWrite, undefined)),
                      Effect.andThen(Deferred.await(written)),
                    )
                  : Effect.void,
              ),
            ),
        }),
      );
      // Read A finishes its lookup under revision 1, but its store write is held back.
      yield* cache.invalidate("pr");
      holding = true;
      const stale = yield* cache
        .get("summary", Effect.succeed("stale"), ["pr"])
        .pipe(Effect.forkChild({ startImmediately: true }));
      // Read B stores its entry under revision 2.
      yield* cache.invalidate("pr");
      yield* cache.get("summary", Effect.succeed("newer"), ["pr"]);
      // Read C under revision 3 refreshes; A's held write lands between its removal and reload.
      yield* cache.invalidate("pr");
      releaseOnRemove = true;

      assert.strictEqual(yield* cache.get("summary", Effect.succeed("fresh"), ["pr"]), "fresh");
      assert.strictEqual(yield* Fiber.join(stale), "stale");
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("cancels abandoned reads without blocking invalidation", () =>
    Effect.gen(function* () {
      const cache = yield* PullRequestReadCache.make;
      const started = yield* Deferred.make<void>();
      const read = yield* cache
        .get("summary", Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)), [
          "pr",
        ])
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(read);
      yield* cache.invalidate("pr");
      assert.strictEqual(yield* cache.get("summary", Effect.succeed("fresh"), ["pr"]), "fresh");
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect(
    "finishes the in-memory revision update when invalidation is canceled after writing",
    () =>
      Effect.gen(function* () {
        const backing = yield* KeyValueStore.KeyValueStore;
        const written = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const cache = yield* PullRequestReadCache.make.pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, {
            ...backing,
            set: (key, value) =>
              backing
                .set(key, value)
                .pipe(
                  Effect.andThen(
                    key === "revisions"
                      ? Deferred.succeed(written, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                        )
                      : Effect.void,
                  ),
                ),
          }),
        );
        yield* cache.get("summary", Effect.succeed("old"), ["pr"]);
        const invalidation = yield* cache.invalidate("pr").pipe(Effect.forkChild);
        yield* Deferred.await(written);
        const interrupt = yield* Fiber.interrupt(invalidation).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupt);
        assert.strictEqual(yield* cache.get("summary", Effect.succeed("fresh"), ["pr"]), "fresh");
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );
});
