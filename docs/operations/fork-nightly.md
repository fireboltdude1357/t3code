# Fork nightly

> Fork-only. This page lives on `patch/release` in fireboltdude1357/t3code and never goes upstream.

The fork ships its own nightlies. Each one is an upstream nightly with the fork's patches merged on top. Fork builds look for updates in the fork's releases (`CLI_RELEASE_REPOSITORY` in `packages/shared/src/cliRelease.ts`, and the desktop feed the workflow writes into `app-update.yml`), so Update, Update all and `t3 update --channel nightly` work the same as on a stock nightly.

The version keeps upstream's nightly shape so every channel check still reads it as nightly. The run number becomes `run * 100 + n` for the fork's nth build of that nightly: `v0.0.46-nightly.20261011.2994` builds as `0.0.46-nightly.20261011.299401`, then `…299402` if a patch changes before the next nightly. A suffix like `.fork.1` makes the desktop and `t3 update` treat the build as stable.

Every client that runs Update all against a fork server has to be a fork build. Update all asks each server for the client's own version, and a stock client's version only exists in Theo's releases.

## Branches

- `patch/<name>` holds one patch. `.github/fork-patches.txt` lists the patches in merge order.
- `fork-main` is generated. Each build merges the nightly and every patch from scratch, then commits that tree with the previous `fork-main` as first parent, so the branch only fast-forwards and clones can keep pulling it. A commit made directly on `fork-main` disappears from the next build.
- `fork-candidate` is the workflow's scratch branch. It is force-pushed on every build.

`fork-main` records what went into it as `Fork-Version`, `Fork-Base` and `Fork-Patch` trailers. The sync compares them with the newest nightly and the patch heads, and builds only when something changed.

## Working on a patch

Branch from `patch/<name>` and open the PR against `patch/<name>`. The next run merges it.

To add a patch:

1. Create `patch/<name>` from the newest upstream nightly tag, not from upstream `main`. A patch based on upstream commits the nightly doesn't have would pull them into the build, so the sync refuses it until a nightly catches up.
2. Add a line to `.github/fork-patches.txt` with a PR into `patch/release`.
3. To offer the patch upstream later, open a PR against pingdotgg/t3code `main` from the same branch, rebased if Theo's `main` has moved.

When a patch merges upstream, delete its line. The nightly carries it from then on.

## Following an upstream PR

A third column ties a patch to an upstream PR: `home patch/home pingdotgg/t3code#15975`. The run warns when the PR has commits the branch doesn't, which means Theo pushed. Merge the PR head into `patch/home` and resolve against the nightly the branch is on.

## When a run fails

A conflict fails the run with the patch name and the conflicting files. Fix it on the patch branch: merge the nightly tag the run used into `patch/<name>`, resolve, and land it with a PR. When two patches conflict with each other, the later one in the list merges the earlier patch branch and resolves there.

Until the fix lands, machines stay on the last fork build that passed.

Run the sync locally to reproduce a failure. It only merges, in a scratch worktree, and prints the commit it would build. It pushes nothing.

```bash
node scripts/fork-sync.ts --force --workdir /tmp/fork-sync
```

## The workflow

`.github/workflows/fork-nightly.yml` runs hourly at :23, about an hour after each upstream nightly ships:

1. `sync` runs `scripts/fork-sync.ts` from `patch/release` and pushes the result to `fork-candidate`.
2. `check` runs the full typecheck and the test files the patches add or change. Upstream already tested the rest.
3. `linux` builds the bundle and the linux-x64 CLI archive. `windows` builds the x64 installer around that archive as its WSL runtime. `macos` runs only when `FORK_BUILD_MACOS` is `true`.
4. `release` publishes `v<version>` as a prerelease, then fast-forwards `fork-main` to the commit it built.
5. `notify` posts the run URL to `FORK_NIGHTLY_WEBHOOK` when anything fails.

A manual run builds without publishing unless `publish` is checked. Fork builds have T3 Connect off, because the workflow sets no relay or Clerk config.

Windows builds are unsigned. The updater installs them because their `app-update.yml` has no publisher to check, and SmartScreen warns once on the first manual install. macOS only installs updates signed with the same identity as the running app, so Mac builds stay off until the fork has a Developer ID, notarization keys and a provisioning profile, set as the secrets and variables `release-desktop.yml` uses.

## Turning it on

These steps change shared state and machines, so each one is done deliberately:

1. Run the workflow by hand with `publish` checked and install the result on one machine first.
2. Make `fork-main` the fork's default branch. GitHub only runs schedules and manual dispatches from workflows on the default branch.
3. Disable the upstream workflows in the fork (`Release` and the others). Their scheduled runs wait forever for Blacksmith runners.
4. Set the `FORK_NIGHTLY_ENABLED` variable to `true`, and optionally `FORK_NIGHTLY_WEBHOOK`.
5. Move each machine onto fork builds once. On the WSL server, an explicit version skips the release index:
   `T3CODE_RELEASE_BASE_URL=https://github.com/fireboltdude1357/t3code/releases/download t3 update <version> --yes`.
   On Windows, run the fork installer over the stock app.
6. Point the Fleet update timer at the fork's releases. It reads `repos/pingdotgg/t3code` in `services/t3-preview-update/preview-update.sh`.
