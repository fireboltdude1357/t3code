---
name: fork-ios-build
description: Build Tanner's fork of the T3 Code iOS app and get it onto his phone, either as a native build on the MacBook Air or as an OTA update for JS-only changes. Use for "rebuild the iOS app", an install link, or syncing the fork with upstream before a build.
---

# Fork iOS build

This checkout is Tanner's fork (`fireboltdude1357/t3code`). Its phone app is the
`preview` EAS profile: "T3 Code Preview", bundle `com.tannersharon.t3code.preview`,
EAS project `@architech-solutions/t3-code`. Read the global `eas-local-build`
skill for the build wrapper, its done criteria and the install page. This skill
covers only what is specific to the fork.

## Fork identity

`apps/mobile/app.config.ts` reads the fork's EAS owner, EAS project ID, Apple
team and bundle prefix from the gitignored repo-root `.env.local` (via
`scripts/lib/public-config.ts`). When those values are missing, the config falls back to
upstream's pingdotgg project, and EAS fails with `Entity Not Authorized:
AppEntity[d763fcb8-…]`. Every build and OTA update needs that file's values in
the environment. The values are not secrets. The reference copies are
`~/code/t3code/.env.local` on the Air and on stl-wsl.

## Pick the base

`fork-v2` is the fork's working branch. The fork's `main` can trail it, but
`fork-v2` always contains it. Build the commit Tanner names, otherwise the tip
of `fork-v2` plus any sync he asked for.

To sync with upstream, **merge** with `git merge --no-ff`. Do not rebase or replay
fork commits; upstream refactors make a replay conflict everywhere. Merge
whichever is newer: upstream `main` or the newest `v*-preview.*` tag. Since
2026-10-05 the fork has merged upstream `main` directly. Then run the mobile
typecheck and the mobile tests (the dependency-graph ceiling test has broken
past merges), push a branch, and ask before moving `fork-v2` or `main`.

## Native build or OTA

A native build is needed when the iOS fingerprint changed: an Expo SDK bump,
a native dependency, or a config plugin. Otherwise, ship by OTA from stl-wsl.
iOS widget layouts are JS, so widget changes ship by OTA too.

```sh
cd apps/mobile
APP_VARIANT=preview npx expo-updates fingerprint:generate --platform ios
```

If the hash matches the runtime version of the installed build, send an OTA.
`EXPO_TOKEN` is in `~/.claude/.env`. The worktree also needs `.env.local`
copied from `~/code/t3code`:

```sh
set -a; . ~/.claude/.env; set +a
APP_VARIANT=preview EXPO_NO_GIT_STATUS=1 eas update --channel preview \
  --environment preview --platform ios --message "<what changed>" --non-interactive
```

Tanner relaunches the app twice to apply it.

## Native build

Push the commit first; the Air builds only pushed commits. Run the
`eas-local-build` wrapper with the fork identity exported. Run it as a
background command and end the turn:

```sh
ssh air 'set -a; source ~/code/t3code/.env.local; set +a;
  ~/code/fleet/skills/universal/eas-local-build/scripts/eas-local-build \
  git@github.com:fireboltdude1357/t3code.git <full-sha> apps/mobile preview \
  ~/builds/t3code-fork-<short-sha>.ipa'
```

A pipe on the SSH command hides the build's exit status. Check the run's
`build.txt` for `exit_code=0` and confirm the IPA exists before you call the
build done.

## Deliver

Publish the IPA with `ipa-install-page`, as described in `eas-local-build`, and give Tanner the
URL. He opens it in Safari with Tailscale on.

A new device or an expired certificate (the current one expires 2027-01-15)
needs new ad-hoc profiles. Tanner registers the device with `eas device:create`.
Delete the stored preview profiles for all three targets (`T3CodePreview`,
sharing, widgets) with `eas credentials -p ios`. Then Tanner runs
`ssh -t tannersharon@tanners-macbook-air.tail1fd0aa.ts.net
'~/t3code-builds/run-interactive-build.sh <ipa>'`, signs in, and selects every
device. Once that profile exists, non-interactive builds work again.
