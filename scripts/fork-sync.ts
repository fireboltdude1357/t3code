#!/usr/bin/env node

/**
 * Builds the fork's next integration commit: upstream main with every patch
 * branch listed in .github/fork-patches.txt merged on top, in order. The result
 * is a commit whose tree is that fresh merge and whose first parent is the
 * current integration branch, so the branch only ever fast-forwards while each
 * build starts clean from upstream.
 *
 * Inputs (the upstream commit and patch heads) are recorded as `Fork-*`
 * trailers on the commit, with the newest upstream nightly the version counts
 * from. When the inputs match the last integration commit there is nothing to
 * build. See docs/operations/fork-nightly.md.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const DEFAULT_UPSTREAM = "https://github.com/pingdotgg/t3code.git";
const UPSTREAM_REF = "refs/fork-sync/upstream";

export interface ForkPatch {
  readonly name: string;
  readonly branch: string;
  /** Upstream PR the branch follows, e.g. `pingdotgg/t3code#15975`. */
  readonly tracks: Option.Option<{ readonly repo: string; readonly number: number }>;
}

export interface ForkManifest {
  readonly version: string;
  /** Upstream main commit the patches merge onto. */
  readonly base: string;
  /** Newest upstream nightly tag when this was built; versions count from it. */
  readonly nightly: string;
  readonly patches: ReadonlyArray<{ readonly name: string; readonly sha: string }>;
}

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  args: Schema.String,
  exitCode: Schema.Int,
}) {
  override get message(): string {
    return `git ${this.args} exited with code ${this.exitCode}.`;
  }
}

export class ForkVersionError extends Schema.TaggedError<ForkVersionError>()("ForkVersionError", {
  nightly: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `Can't version a fork build after ${this.nightly}: ${this.reason}.`;
  }
}

export class PatchListError extends Schema.TaggedError<PatchListError>()("PatchListError", {
  line: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `Bad patch list line '${this.line}': ${this.reason}.`;
  }
}

export class NoNightlyTagError extends Schema.TaggedError<NoNightlyTagError>()(
  "NoNightlyTagError",
  { upstream: Schema.String },
) {
  override get message(): string {
    return `No nightly tags found on ${this.upstream}.`;
  }
}

export class PatchConflictError extends Schema.TaggedError<PatchConflictError>()(
  "PatchConflictError",
  { patch: Schema.String, base: Schema.String, files: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Patch '${this.patch}' conflicts with ${this.base} plus the patches before it:\n${this.files.map((file) => `  ${file}`).join("\n")}`;
  }
}

export class PartialCloneError extends Schema.TaggedError<PartialCloneError>()(
  "PartialCloneError",
  { remote: Schema.String },
) {
  override get message(): string {
    return `This is a partial clone of '${this.remote}', so a content merge can ask it for a blob that only exists after the merge. Run the sync in a full clone: no --filter, and no sparse checkout in actions/checkout.`;
  }
}

/**
 * Parses `.github/fork-patches.txt`: one `<name> <branch> [<owner>/<repo>#<pr>]`
 * per line, merged in file order. `#` after whitespace starts a comment.
 */
export const parsePatchList = Effect.fn("parsePatchList")(function* (source: string) {
  const patches: Array<ForkPatch> = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") continue;
    const [name, branch, tracks, ...rest] = line.split(/\s+/);
    if (name === undefined || branch === undefined || rest.length > 0) {
      return yield* new PatchListError({ line, reason: "expected '<name> <branch> [repo#pr]'" });
    }
    if (patches.some((patch) => patch.name === name)) {
      return yield* new PatchListError({ line, reason: `duplicate patch name '${name}'` });
    }
    let tracked: ForkPatch["tracks"] = Option.none();
    if (tracks !== undefined) {
      const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(tracks);
      if (match?.[1] === undefined || match[2] === undefined) {
        return yield* new PatchListError({
          line,
          reason: `'${tracks}' is not <owner>/<repo>#<pr>`,
        });
      }
      tracked = Option.some({ repo: match[1], number: Number(match[2]) });
    }
    patches.push({ name, branch, tracks: tracked });
  }
  return patches;
});

const NIGHTLY_TAG = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/;

/** Picks the newest `v<x.y.z>-nightly.<date>.<run>` tag; other tags are ignored. */
export const latestNightlyTag = (tags: ReadonlyArray<string>): Option.Option<string> => {
  const compare = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) =>
    a.map((part, index) => part - (b[index] ?? 0)).find((diff) => diff !== 0) ?? 0;
  const nightlies = tags.flatMap((tag) => {
    const match = NIGHTLY_TAG.exec(tag);
    return match ? [{ tag, key: match.slice(1).map(Number) }] : [];
  });
  return Option.fromNullishOr(nightlies.toSorted((a, b) => compare(b.key, a.key))[0]?.tag);
};

/**
 * The fork release version, counted from the newest upstream nightly tag. The
 * run number becomes `run * 100 + n` for the fork's nth build since that
 * nightly, so builds after `v0.0.46-nightly.20261011.2994` are
 * `0.0.46-nightly.20261011.299401`, `…299402` and so on. The version stays a
 * plain nightly that every channel check accepts, which a suffix like
 * `.fork.1` would not.
 */
export const forkVersion = Effect.fn("forkVersion")(function* (
  nightly: string,
  previous: Option.Option<ForkManifest>,
) {
  const match = NIGHTLY_TAG.exec(nightly);
  if (!match) {
    return yield* new ForkVersionError({ nightly, reason: "not a nightly tag" });
  }
  const [, major, minor, patch, date, run] = match;
  const build = Option.match(previous, {
    onNone: () => 1,
    onSome: (manifest) =>
      manifest.nightly === nightly ? (Number(manifest.version.split(".").at(-1)) % 100) + 1 : 1,
  });
  if (build > 99) {
    return yield* new ForkVersionError({ nightly, reason: "already built 99 times" });
  }
  return `${major}.${minor}.${patch}-nightly.${date}.${Number(run) * 100 + build}`;
});

export const formatForkManifest = (manifest: ForkManifest): string =>
  [
    `fork: ${manifest.version}`,
    "",
    `Upstream main at ${manifest.base} with the fork patches merged on top.`,
    "",
    `Fork-Version: ${manifest.version}`,
    `Fork-Base: ${manifest.base}`,
    `Fork-Nightly: ${manifest.nightly}`,
    ...manifest.patches.map((patch) => `Fork-Patch: ${patch.name} ${patch.sha}`),
  ].join("\n");

/** Reads the manifest back from a commit message; none for commits the sync didn't make. */
export const parseForkManifest = (message: string): Option.Option<ForkManifest> => {
  let version: string | undefined;
  let base: string | undefined;
  let nightly: string | undefined;
  const patches: Array<ForkManifest["patches"][number]> = [];
  for (const line of message.split(/\r?\n/)) {
    const match = /^Fork-(Version|Base|Nightly|Patch): (.+)$/.exec(line.trim());
    if (!match) continue;
    const value = match[2] ?? "";
    if (match[1] === "Version") version = value;
    else if (match[1] === "Base") base = value;
    else if (match[1] === "Nightly") nightly = value;
    else {
      const [name, sha] = value.split(" ");
      if (name !== undefined && sha !== undefined) patches.push({ name, sha });
    }
  }
  // Builds before the fork followed main used the nightly tag as their base.
  return version === undefined || base === undefined
    ? Option.none()
    : Option.some({ version, base, nightly: nightly ?? base, patches });
};

const sameInputs = (a: ForkManifest, b: Omit<ForkManifest, "version" | "nightly">) =>
  a.base === b.base &&
  a.patches.length === b.patches.length &&
  a.patches.every(
    (patch, index) => patch.name === b.patches[index]?.name && patch.sha === b.patches[index]?.sha,
  );

/** Runs git and returns trimmed stdout. Stderr goes to the log. */
export const git = Effect.fn("git")(function* (args: ReadonlyArray<string>, cwd?: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("git", args, { cwd, stderr: "inherit" }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0) {
        return yield* new GitCommandError({ args: args.join(" "), exitCode: Number(exitCode) });
      }
      return stdout.trim();
    }),
  );
});

const gitSucceeds = (args: ReadonlyArray<string>, cwd?: string) =>
  git(args, cwd).pipe(
    Effect.as(true),
    Effect.catchTags({ GitCommandError: () => Effect.succeed(false) }),
  );

/**
 * Fails when any remote is a promisor, meaning a partial clone. A content merge
 * there asks the promisor for the merged blob, which doesn't exist yet.
 */
export const assertFullClone = Effect.fn("assertFullClone")(function* (cwd?: string) {
  const promisors = yield* git(
    ["config", "--type=bool", "--get-regexp", String.raw`^remote\..*\.promisor$`],
    cwd,
  ).pipe(
    // `git config` exits 1 when no key matches, which means a full clone.
    Effect.catchTags({
      GitCommandError: (error) => (error.exitCode === 1 ? Effect.succeed("") : Effect.fail(error)),
    }),
  );
  const remote = /^remote\.(.+)\.promisor true$/m.exec(promisors)?.[1];
  if (remote !== undefined) return yield* new PartialCloneError({ remote });
});

/**
 * Merges one patch into the worktree at `cwd`. Only unmerged files make a
 * conflict, which is aborted and reported. Any other merge failure keeps git's
 * own error, which the log shows above it.
 */
export const mergePatch = Effect.fn("mergePatch")(function* (
  cwd: string,
  patch: ForkPatch & { readonly sha: string },
  base: string,
) {
  yield* git(
    ["merge", "--no-ff", "-m", `fork: merge ${patch.name} (${patch.branch})`, patch.sha],
    cwd,
  ).pipe(
    Effect.catchTags({
      GitCommandError: (error) =>
        Effect.gen(function* () {
          const files = (yield* git(["diff", "--name-only", "--diff-filter=U"], cwd))
            .split("\n")
            .filter((file) => file !== "");
          if (files.length === 0) return yield* error;
          yield* git(["merge", "--abort"], cwd);
          return yield* new PatchConflictError({ patch: patch.name, base, files });
        }),
    }),
  );
});

interface SyncOptions {
  readonly patchList: string;
  readonly remote: string;
  readonly upstream: string;
  readonly integrationBranch: string;
  readonly base: string;
  readonly workdir: string;
  readonly force: boolean;
}

export const syncFork = Effect.fn("syncFork")(function* (options: SyncOptions) {
  const fs = yield* FileSystem.FileSystem;
  const patches = yield* parsePatchList(yield* fs.readFileString(options.patchList));
  const remoteRef = (branch: string) => `refs/remotes/${options.remote}/${branch}`;

  yield* assertFullClone();

  yield* git([
    "fetch",
    "--quiet",
    "--no-tags",
    options.remote,
    ...[options.integrationBranch, ...patches.map((patch) => patch.branch)].map(
      (branch) => `+refs/heads/${branch}:${remoteRef(branch)}`,
    ),
  ]);

  const nightly = yield* git([
    "ls-remote",
    "--tags",
    "--refs",
    options.upstream,
    "v*-nightly.*",
  ]).pipe(
    Effect.map((out) => out.split("\n").map((line) => line.replace(/^.*refs\/tags\//, ""))),
    Effect.flatMap((tags) =>
      Effect.fromOption(latestNightlyTag(tags)).pipe(
        Effect.mapError(() => new NoNightlyTagError({ upstream: options.upstream })),
      ),
    ),
  );
  yield* git([
    "fetch",
    "--quiet",
    "--no-tags",
    options.upstream,
    `+${options.base}:${UPSTREAM_REF}`,
  ]);
  const base = yield* git(["rev-parse", UPSTREAM_REF]);

  const warnings: Array<string> = [];
  const resolved: Array<ForkPatch & { readonly sha: string }> = [];
  for (const patch of patches) {
    const sha = yield* git(["rev-parse", remoteRef(patch.branch)]);
    if (Option.isSome(patch.tracks)) {
      const { repo, number } = patch.tracks.value;
      const prRef = `refs/fork-sync/pr/${number}`;
      yield* git([
        "fetch",
        "--quiet",
        "--no-tags",
        `https://github.com/${repo}.git`,
        `+refs/pull/${number}/head:${prRef}`,
      ]);
      if (!(yield* gitSucceeds(["merge-base", "--is-ancestor", prRef, sha]))) {
        warnings.push(
          `${patch.name}: ${repo}#${number} has commits ${patch.branch} doesn't include yet.`,
        );
      }
    }
    resolved.push({ ...patch, sha });
  }

  const previousSha = yield* git(["rev-parse", remoteRef(options.integrationBranch)]);
  const previous = parseForkManifest(yield* git(["log", "-1", "--format=%B", previousSha]));
  const inputs = { base, patches: resolved.map(({ name, sha }) => ({ name, sha })) };
  for (const warning of warnings) yield* Console.warn(`warning: ${warning}`);

  if (!options.force && Option.isSome(previous) && sameInputs(previous.value, inputs)) {
    yield* Console.log(
      `Up to date: ${options.integrationBranch} already has ${previous.value.version}.`,
    );
    return Option.none();
  }

  const manifest: ForkManifest = {
    version: yield* forkVersion(nightly, previous),
    nightly,
    ...inputs,
  };
  const integration = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        git(["worktree", "add", "--quiet", "--detach", "--force", options.workdir, base]),
        () => git(["worktree", "remove", "--force", options.workdir]).pipe(Effect.ignore),
      );
      for (const patch of resolved) {
        yield* mergePatch(options.workdir, patch, base);
      }
      return yield* git(["rev-parse", "HEAD"], options.workdir);
    }),
  );

  const commit = yield* git([
    "commit-tree",
    `${integration}^{tree}`,
    "-p",
    previousSha,
    "-p",
    integration,
    "-m",
    formatForkManifest(manifest),
  ]);
  yield* Console.log(`Built ${manifest.version} as ${commit}.`);
  return Option.some({ manifest, commit });
});

const writeOutputs = Effect.fn("writeOutputs")(function* (
  entries: ReadonlyArray<readonly [string, string]>,
  githubOutput: boolean,
) {
  if (!githubOutput) {
    for (const [key, value] of entries) yield* Console.log(`${key}=${value}`);
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const outputPath = yield* Config.NonEmptyString("GITHUB_OUTPUT");
  yield* fs.writeFileString(
    outputPath,
    entries.map(([key, value]) => `${key}=${value}\n`).join(""),
    { flag: "a" },
  );
});

const command = Command.make(
  "fork-sync",
  {
    patchList: Flag.String("patch-list").pipe(
      Flag.withDescription("Patch list file."),
      Flag.withDefault(".github/fork-patches.txt"),
    ),
    remote: Flag.String("remote").pipe(
      Flag.withDescription("Git remote for the fork."),
      Flag.withDefault("origin"),
    ),
    upstream: Flag.String("upstream").pipe(
      Flag.withDescription("Upstream repository URL to build from."),
      Flag.withDefault(DEFAULT_UPSTREAM),
    ),
    integrationBranch: Flag.String("integration-branch").pipe(
      Flag.withDescription("Fork branch the integration commit fast-forwards."),
      Flag.withDefault("fork-main"),
    ),
    base: Flag.String("base").pipe(
      Flag.withDescription("Upstream ref to build on."),
      Flag.withDefault("refs/heads/main"),
    ),
    workdir: Flag.String("workdir").pipe(
      Flag.withDescription("Scratch worktree path for the merge."),
      Flag.withDefault(".fork-sync"),
    ),
    force: Flag.Boolean("force").pipe(
      Flag.withDescription("Build even when the inputs match the last integration commit."),
      Flag.withDefault(false),
    ),
    githubOutput: Flag.Boolean("github-output").pipe(
      Flag.withDescription("Write results to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
  },
  ({ githubOutput, ...options }) =>
    syncFork(options).pipe(
      Effect.flatMap((result) =>
        writeOutputs(
          Option.match(result, {
            onNone: () => [["changed", "false"]] as const,
            onSome: ({ manifest, commit }) =>
              [
                ["changed", "true"],
                ["version", manifest.version],
                ["tag", `v${manifest.version}`],
                ["base", manifest.base],
                ["commit", commit],
              ] as const,
          }),
          githubOutput,
        ),
      ),
    ),
).pipe(Command.withDescription("Merge the fork patches onto upstream main."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
