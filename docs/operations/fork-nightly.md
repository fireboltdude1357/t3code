# Fork nightly

> Fork-only. This page lives on `patch/release` in fireboltdude1357/t3code and never goes upstream.

The fork ships its own nightlies. Each one is upstream `main` with the fork's patches merged on top, built every two hours when `main` or a patch has changed. Following `main` gets upstream changes hours before Theo's next nightly, without the testing a nightly gets first. Fork builds look for updates in the fork's releases (`CLI_RELEASE_REPOSITORY` in `packages/shared/src/cliRelease.ts`, and the desktop feed the workflow writes into `app-update.yml`), so Update, Update all and `t3 update --channel nightly` work the same as on a stock nightly.

The version keeps upstream's nightly shape so every channel check still reads it as nightly. It counts from the newest upstream nightly tag: the run number becomes `run * 100 + n` for the fork's nth build since that nightly. After `v0.0.46-nightly.20261011.2994` the builds are `0.0.46-nightly.20261011.299401`, `…299402` and so on, and the next nightly starts again at `…01`. A suffix like `.fork.1` makes the desktop and `t3 update` treat the build as stable.

Every client that runs Update all against a fork server has to be a fork build. Update all asks each server for the client's own version, and a stock client's version only exists in Theo's releases.

## Branches

- `patch/<name>` holds one patch. `.github/fork-patches.txt` lists the patches in merge order.
- `fork-main` is generated. Each build merges upstream `main` and every patch from scratch, then commits that tree with the previous `fork-main` as first parent, so the branch only fast-forwards and clones can keep pulling it. A commit made directly on `fork-main` disappears from the next build.
- `fork-candidate` is the workflow's scratch branch. It is force-pushed on every build.

`fork-main` records what went into it as `Fork-Version`, `Fork-Base` (the upstream `main` commit), `Fork-Nightly` and `Fork-Patch` trailers. The sync compares the base and patches with upstream `main` and the patch heads, and builds only when something changed.

## Working on a patch

Branch from `patch/<name>` and open the PR against `patch/<name>`. The next run merges it.

To add a patch:

1. Create `patch/<name>` from upstream `main`.
2. Add a line to `.github/fork-patches.txt` with a PR into `patch/release`.
3. To offer the patch upstream later, open a PR against pingdotgg/t3code `main` from the same branch, rebased if Theo's `main` has moved.

When a patch merges upstream, delete its line. Upstream `main` carries it from then on.

## Following an upstream PR

A third column ties a patch to an upstream PR: `home patch/home pingdotgg/t3code#15975`. The run warns when the PR has commits the branch doesn't, which means Theo pushed. Merge the PR head into `patch/home` and resolve there.

## When a run fails

A conflict fails the run with the patch name and the conflicting files. Fix it on the patch branch: merge the upstream commit the run used (`base` in the sync output) into `patch/<name>`, resolve, and land it with a PR. When two patches conflict with each other, the later one in the list merges the earlier patch branch and resolves there.

Until the fix lands, machines stay on the last fork build that passed.

Run the sync locally to reproduce a failure. It only merges, in a scratch worktree, and prints the commit it would build. It pushes nothing.

```bash
node scripts/fork-sync.ts --force --workdir /tmp/fork-sync
```

## The workflow

`.github/workflows/fork-nightly.yml` runs every two hours, dispatched by Fleet's `t3-fork-build.timer` on stl-wsl. GitHub doesn't run cron schedules in this fork, so the workflow has none.

1. `sync` runs `scripts/fork-sync.ts` from `patch/release` and pushes the result to `fork-candidate`.
2. `check` runs the full typecheck and the test files the patches add or change. Upstream CI tests the rest of `main`.
3. `linux` builds the bundle and the linux-x64 CLI archive. `windows` builds the x64 installer around that archive as its WSL runtime. `macos` runs only when `FORK_BUILD_MACOS` is `true`.
4. `release` publishes `v<version>` as a prerelease, then fast-forwards `fork-main` to the commit it built.
5. `notify` posts the run URL to `FORK_NIGHTLY_WEBHOOK` when anything fails.

A manual run builds without publishing unless `publish` is checked. The bundle build copies `.env.example` to `.env`, so fork builds use upstream's relay and Clerk instance and T3 Connect works as it does on stock builds.

Windows builds are unsigned. The updater installs them because their `app-update.yml` has no publisher to check, and SmartScreen warns once on the first manual install.

Mac builds are signed with Architech's Developer ID and notarized, from the `CSC_LINK`, `CSC_KEY_PASSWORD` and `APPLE_API_KEY*` secrets, when `FORK_BUILD_MACOS` is `true`. macOS only installs an update signed by the running app's identity, so a Mac moves from Theo's build to the fork's by hand once. There is no provisioning profile: `com.t3tools.t3code` belongs to Theo's team, and the passkey domains only trust his. Without one the build skips the passkey entitlements, so the in-app browser can't use passkeys.

## Setup

- `patch/release` is the fork's default branch. GitHub only dispatches workflows that exist on the default branch, and this way a workflow change takes effect without a build.
- The upstream workflows are disabled in the fork. Their runs wait forever for Blacksmith runners.
- `FORK_PUSH_TOKEN` is a fine-grained token for this repo with Contents and Workflows read and write. The workflow pushes `fork-candidate` and `fork-main` with it, because upstream commits change workflow files and `GITHUB_TOKEN` may not push those. When it expires, the sync job fails at its push step until the secret is replaced.
- `FORK_BUILD_MACOS` is `true`. `FORK_NIGHTLY_WEBHOOK` is optional. Stopping `t3-fork-build.timer` on stl-wsl stops the builds.
- Fleet's updater on stl-wsl (`services/t3-preview-update/`) installs each fork nightly on the WSL server.

A machine moves onto fork builds once:

- WSL server: an explicit version skips the release index.
  `T3CODE_RELEASE_BASE_URL=https://github.com/fireboltdude1357/t3code/releases/download t3 update <version> --yes`
- Windows: run the fork installer over the stock app with `/S`.
- Mac: quit T3 Code and replace `/Applications/T3 Code (Nightly).app` with the app from the fork's zip or DMG.
