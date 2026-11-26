import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import {
  assertFullClone,
  forkVersion,
  formatForkManifest,
  git,
  latestNightlyTag,
  mergePatch,
  parseForkManifest,
  parsePatchList,
} from "./fork-sync.ts";

it.effect("parses patch lines in order, with an optional tracked upstream PR", () =>
  Effect.gen(function* () {
    const patches = yield* parsePatchList(
      [
        "# name  branch  tracks",
        "release patch/release",
        "",
        "home    patch/home    pingdotgg/t3code#15975  # Theo's PR",
      ].join("\n"),
    );
    assert.deepStrictEqual(
      patches.map(({ name, branch, tracks }) => [name, branch, Option.getOrUndefined(tracks)]),
      [
        ["release", "patch/release", undefined],
        ["home", "patch/home", { repo: "pingdotgg/t3code", number: 15975 }],
      ],
    );
  }),
);

it.effect("rejects duplicate patch names", () =>
  Effect.gen(function* () {
    const error = yield* parsePatchList("voice patch/voice\nvoice patch/other").pipe(Effect.flip);
    assert.equal(error.reason, "duplicate patch name 'voice'");
  }),
);

it("picks the newest nightly by version, date, then run number", () => {
  assert.equal(
    Option.getOrUndefined(
      latestNightlyTag([
        "v0.0.46-nightly.20261011.2980",
        "v0.0.46-preview.20261012.3000",
        "v0.0.46-nightly.20261011.2994",
        "v0.0.46-nightly.20261010.2999",
        "android-nightly",
      ]),
    ),
    "v0.0.46-nightly.20261011.2994",
  );
  assert.equal(
    Option.getOrUndefined(
      latestNightlyTag(["v0.0.46-nightly.20261011.2994", "v0.0.47-nightly.20261012.3"]),
    ),
    "v0.0.47-nightly.20261012.3",
  );
});

it.effect("numbers fork builds per nightly and round-trips the manifest", () =>
  Effect.gen(function* () {
    const nightly = "v0.0.46-nightly.20261011.2994";
    const first = {
      version: yield* forkVersion(nightly, Option.none()),
      base: "5753207d53e2a9c0d1f8b6e4a3c2b1d0e9f8a7b6",
      nightly,
      patches: [{ name: "home", sha: "b5d05a6ebf" }],
    };
    assert.equal(first.version, "0.0.46-nightly.20261011.299401");

    const parsed = parseForkManifest(formatForkManifest(first));
    assert.deepStrictEqual(Option.getOrUndefined(parsed), first);
    // A newer main on the same nightly counts up; a new nightly starts over.
    assert.equal(yield* forkVersion(nightly, parsed), "0.0.46-nightly.20261011.299402");
    assert.equal(
      yield* forkVersion("v0.0.46-nightly.20261012.3001", parsed),
      "0.0.46-nightly.20261012.300101",
    );
    assert.isTrue(Option.isNone(parseForkManifest("Merge pull request #13")));
  }),
);

it.effect("keeps counting from builds made on a nightly tag", () =>
  Effect.gen(function* () {
    const legacy = parseForkManifest(
      [
        "fork: 0.0.46-nightly.20261012.301003",
        "",
        "Fork-Version: 0.0.46-nightly.20261012.301003",
        "Fork-Base: v0.0.46-nightly.20261012.3010",
      ].join("\n"),
    );
    assert.equal(
      yield* forkVersion("v0.0.46-nightly.20261012.3010", legacy),
      "0.0.46-nightly.20261012.301004",
    );
  }),
);

/** A repo with one commit on `main` and a `patch` branch that rewrites `a.txt`. */
const makeRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-sync-test-" });
  const run = (...args: Array<string>) => git(args, cwd);
  yield* run("init", "--quiet", "--initial-branch=main");
  yield* run("config", "user.name", "test");
  yield* run("config", "user.email", "test@example.com");
  // Keep the host's signing and hooks out of fixture commits and merges.
  yield* run("config", "commit.gpgsign", "false");
  yield* run("config", "core.hooksPath", "/dev/null");
  yield* fs.writeFileString(`${cwd}/a.txt`, "base\n");
  yield* run("add", "a.txt");
  yield* run("commit", "--quiet", "-m", "base");
  yield* run("switch", "--quiet", "-c", "patch");
  yield* fs.writeFileString(`${cwd}/a.txt`, "patch\n");
  yield* run("commit", "--quiet", "-am", "patch");
  yield* run("switch", "--quiet", "main");
  const patch = {
    name: "test",
    branch: "patch",
    tracks: Option.none(),
    sha: yield* run("rev-parse", "patch"),
  };
  return { cwd, run, patch };
});

it.layer(NodeServices.layer)("git", (it) => {
  it.effect("refuses to sync in a partial clone", () =>
    Effect.gen(function* () {
      const { cwd, run } = yield* makeRepo;
      yield* assertFullClone(cwd);
      yield* run("remote", "add", "origin", "https://example.com/fork.git");
      yield* run("config", "remote.origin.promisor", "true");
      const error = yield* assertFullClone(cwd).pipe(Effect.flip);
      assert.equal(error._tag, "PartialCloneError");
    }),
  );

  it.effect("reports a conflict with its files and leaves no merge in progress", () =>
    Effect.gen(function* () {
      const { cwd, run, patch } = yield* makeRepo;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${cwd}/a.txt`, "upstream\n");
      yield* run("commit", "--quiet", "-am", "upstream");
      const error = yield* mergePatch(cwd, patch, "main").pipe(Effect.flip);
      assert.equal(error._tag, "PatchConflictError");
      if (error._tag === "PatchConflictError") assert.deepStrictEqual(error.files, ["a.txt"]);
      assert.equal(yield* run("status", "--porcelain"), "");
    }),
  );

  it.effect("keeps git's error when a merge fails without a conflict", () =>
    Effect.gen(function* () {
      const { cwd, patch } = yield* makeRepo;
      const error = yield* mergePatch(cwd, { ...patch, sha: "0".repeat(40) }, "main").pipe(
        Effect.flip,
      );
      assert.equal(error._tag, "GitCommandError");
      if (error._tag === "GitCommandError") assert.match(error.args, /^merge --no-ff /);
    }),
  );
});
