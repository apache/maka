---
title: OTA Updates
description: "Deliver a packaged app's TSX as a signed package, to iOS and Android too, without a new app build: keys, releases from CI, the in-app flow, trial runs and rollback."
order: 20.7
group: delivery
---

# OTA Updates

OTA (over-the-air) updates deliver a packaged app's TSX as a [signed package](./signed-packages.md) (`.nshpkg`): the
installed app downloads it, verifies it and runs it from its next start, on every native platform, iOS and Android
included, without a new app build. A release is the package and a signed manifest, on GitHub Releases or your own
host. In the app, four functions of [`nsh/updater`](../modules/nsh-updater.md#ota-updates) check, download, restart into
and report the package. A package that fails at its first start is deleted, and the app goes back to what it ran
before.

| Platform | What OTA does |
| --- | --- |
| macOS, Windows, Linux | Checks and downloads; `restartToPackage()` restarts the app into the package, or it runs from the next start |
| iOS, Android | Checks and downloads; the package runs from the app's next cold start, and `restartToPackage()` rejects |
| Web | Nothing to do: a deploy updates the app, and `checkForPackage()` resolves `null` |

## OTA or a new app build

A package holds what `nsh publish` builds from the app's TSX: its code, the images and fonts it imports, and the
capabilities it declares. Everything else is part of the installed app, and changing it takes a new app build: from
the stores on iOS and Android, and through [App Updates](./app-updates.md) or the stores on the desktop.

| Change | OTA | New app build |
| --- | --- | --- |
| Screens, logic, styles, imported images and fonts (TSX) | Yes | |
| A newer NSH version the TSX needs | | Yes |
| The app's Rust code: its crate's components, modules and native views | | Yes |
| What the platform reads from the installed app: name, icon, URL schemes, `ios`, `android` and `macos` keys, permissions | | Yes |
| More [capabilities](./sandbox-and-capabilities.md) than the installed app declares | | Yes: a package gets at most the installed app's |
| `"updater"` in `nsh.json`: the manifest's source, the trusted roots | | Yes |

Each package names the lowest NSH runtime that runs it (`minRuntime`), by default the version of the `nsh` that
published it, and an app with an older runtime is not offered it. Publish OTA releases with the `nsh` version the apps
in the field were built with, or with `--min-runtime` when the TSX uses only what that runtime has ([Which runtimes run
a package](./signed-packages.md#which-runtimes-run-a-package)). When the app needs a newer runtime, ship a new app
build; the app below checks for a package first and for a new app when there is none.

## Set up once

### Keys

```sh
nsh keygen keys/root      # the app trusts it; keep keys/root.secret offline
nsh keygen keys/release   # signs the packages, in CI
nsh keygen keys/update    # signs the manifest, in CI
nsh certify --root keys/root.secret --key keys/release.pub --apps com.example.notes -o keys/release.cert
```

The root certifies the release key for the app's id; the app trusts only the root, so a new release key or
certificate needs no app update. A certificate lasts 365 days unless `--days` says otherwise: certify the release key
again before it runs out. [Signed Packages](./signed-packages.md#keys-two-levels) explains the keys, and how to revoke
a release key or a package.

> [!CAUTION]
> Keep `root.secret` offline, for example on an encrypted drive in a safe: whoever has it can make every installed
> copy of the app run their code. Never commit a `.secret`.

### nsh.json

```json
{
  "id": "com.example.notes",
  "version": "1.2.0",
  "build": 12,
  "updater": {
    "github": "example/notes",
    "publicKey": "<contents of keys/update.pub>",
    "packages": { "roots": ["<contents of keys/root.pub>"] }
  }
}
```

`"packages": { "roots" }` lists the root public keys whose certified release keys may sign the app's packages; several
roots let you rotate one. `publicKey` makes the app refuse a manifest that `keys/update.secret` did not sign. With
`"url"` instead of `"github"`, it is required ([App Updates](./app-updates.md#set-the-source)).

`nsh package` writes `"updater"` and `build` into the app, so the roots an app trusts and the build it compares
packages with are fixed when it is built. Only app builds made with this configuration take OTA updates: ship one
before the first OTA release.

### CI secrets

Store the release key, its certificate and the update key as secrets of the repository that publishes the releases:

```sh
gh secret set NSH_RELEASE_KEY < keys/release.secret
gh secret set NSH_RELEASE_CERT < keys/release.cert
gh secret set NSH_UPDATE_KEY < keys/update.secret
```

## Publish a release

### Build numbers

`build` in `nsh.json` is one counter for app builds and packages: raise it for every release of either. An app runs a
package only when the package's build is higher than the build the app was built with, and is offered only packages
newer than the code it runs. When a new app build 20 is installed, a downloaded package 15 is older code: it is
deleted, and the next OTA release must be build 21. Raise `version` as well; `runningPackage()` reports the package's
version and build.

### By hand

```sh
mkdir -p dist
nsh publish --key keys/release.secret --cert keys/release.cert -o dist/com.example.notes-13.nshpkg
nsh update-manifest --package dist/com.example.notes-13.nshpkg --notes CHANGES.md --key keys/update.secret -o dist
```

`nsh publish` builds the app in release mode and signs it, taking the id, `version` and `build` from `nsh.json`
(`--app-version` and `--build` override them). `nsh update-manifest` checks the package against the app's id and the
roots in `nsh.json`, then writes `dist/latest.json` with a `"package"` entry and signs it into `dist/latest.json.sig`:

```json
{
  "id": "com.example.notes",
  "version": "1.2.1",
  "notes": "Faster search.",
  "platforms": {},
  "package": {
    "version": "1.2.1",
    "build": 13,
    "url": "com.example.notes-13.nshpkg",
    "sha256": "9f2c…",
    "size": 48213,
    "minRuntime": "0.4.0"
  }
}
```

The package's `url` is its file name, next to the manifest; `--base-url` puts it elsewhere. A release with only a
package passes no archives and no `--link`, so `checkForUpdate` finds no new app in it. A release can also carry both:
`nsh update-manifest *.tar.gz *.zip --package … --link ios=…` ([App Updates](./app-updates.md#publish-a-release)).

Upload the package, `latest.json` and `latest.json.sig` to a GitHub Release:

```sh
gh release create v1.2.1 dist/com.example.notes-13.nshpkg dist/latest.json dist/latest.json.sig --notes-file CHANGES.md
```

or next to each other on your host, the package first and the manifest and its signature last, so that no app finds a
manifest whose package is not there yet. On GitHub, a release marked as a draft or prerelease is not offered.

### From GitHub Actions

Raise `version` and `build` in `nsh.json`, commit, and push a tag such as `v1.2.1`:

```yaml
# .github/workflows/ota.yml
name: OTA release
on:
  push:
    tags: ["v*"]

jobs:
  ota:
    runs-on: macos-latest
    permissions:
      contents: write # create the release
    env:
      # The nsh the apps in the field were built with, such as v0.5.0 (a repository variable); empty: the latest.
      NSH_VERSION: ${{ vars.NSH_VERSION }}
    steps:
      - uses: actions/checkout@v4

      - name: Install nsh
        run: |
          curl -fsSL https://nsh.dev/install.sh | sh
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"

      - name: Write the keys
        env:
          RELEASE_KEY: ${{ secrets.NSH_RELEASE_KEY }}
          RELEASE_CERT: ${{ secrets.NSH_RELEASE_CERT }}
          UPDATE_KEY: ${{ secrets.NSH_UPDATE_KEY }}
        run: |
          mkdir -p "$RUNNER_TEMP/keys"
          printf '%s\n' "$RELEASE_KEY" > "$RUNNER_TEMP/keys/release.secret"
          printf '%s\n' "$RELEASE_CERT" > "$RUNNER_TEMP/keys/release.cert"
          printf '%s\n' "$UPDATE_KEY" > "$RUNNER_TEMP/keys/update.secret"

      - name: Publish the package and the manifest
        run: |
          mkdir -p dist
          PACKAGE="dist/$(jq -r .id nsh.json)-$(jq -r .build nsh.json).nshpkg"
          nsh publish --key "$RUNNER_TEMP/keys/release.secret" --cert "$RUNNER_TEMP/keys/release.cert" -o "$PACKAGE"
          nsh update-manifest --package "$PACKAGE" --notes CHANGES.md --key "$RUNNER_TEMP/keys/update.secret" -o dist
          echo "PACKAGE=$PACKAGE" >> "$GITHUB_ENV"

      - name: Create the release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" "$PACKAGE" dist/latest.json dist/latest.json.sig --notes-file CHANGES.md
```

To publish to your own host, replace the last step with your upload, in the order above.

## In the app

The functions run one at a time, like the rest of `nsh/updater`: a call while another check, download or install runs
rejects. This module checks for a package first, and for a new app only when there is none:

```tsx
// updates.ts
import { openUrl, signal } from "nsh";
import { isAvailable as canRestart } from "nsh/desktop";
import {
  checkForPackage,
  checkForUpdate,
  downloadPackage,
  downloadUpdate,
  installAndRestart,
  restartToPackage,
  type AppUpdate,
} from "nsh/updater";

/** A package is downloaded and the app can restart into it (the desktops). */
export const packageReady = signal(false);
/** A new app, for a change a package cannot carry. */
export const appUpdate = signal<AppUpdate | null>(null);

export async function checkForUpdates() {
  try {
    if (await checkForPackage()) {
      await downloadPackage();
      // iOS and Android: nothing to show, the package runs from the next cold start.
      packageReady.set(canRestart);
      return;
    }
    appUpdate.set(await checkForUpdate());
  } catch (error) {
    console.warn("update check failed:", error); // the next check tries again
  }
}

export const restart = () => restartToPackage();

export async function installApp() {
  const update = appUpdate();
  if (!update) return;
  if (!update.canInstall) return openUrl(update.url); // the store
  await downloadUpdate();
  await installAndRestart();
}
```

Call `checkForUpdates()` once the app has started, and again now and then if it stays open for long. On the desktop,
offer the restart:

```tsx
import { Text, View } from "nsh";
import { Button } from "nsh/base";
import { packageReady, restart } from "./updates";

export function UpdateBanner() {
  return (
    <If when={packageReady()}>
      <View class="flex-row items-center gap-3 rounded-(--radius) bg-muted px-4 py-2">
        <Text class="flex-1 text-foreground">A new version is ready.</Text>
        <Button onPress={restart} class="rounded-(--radius) bg-primary px-3 py-1.5 active:bg-primary/90">
          <Text class="text-primary-foreground">Restart</Text>
        </Button>
      </View>
    </If>
  );
}
```

`restartToPackage()` restarts the app as `Application.restart()` does: this run quits as when the user quits it, and
the app starts again into the package. A user who does not restart gets the package the next time they open the app.

`runningPackage()` says what this run's code is, and `shellInfo()` what runs it: the installed app's own version and
build and its NSH runtime. Both are for an About screen or error reports:

```tsx
import { runningPackage, shellInfo } from "nsh/updater";

const running = runningPackage(); // { version, build }, or null for the code the app was built with
const shell = shellInfo(); // { version, build, nshVersion, packages }: the installed app
```

An app installed before it took packages (or built with a runtime without them) never gets one: `packages` is false
there, or `shellInfo` itself is missing on runtimes older than it, and only installing the whole app again helps.

[nsh/updater](../modules/nsh-updater.md#ota-updates) has every function and its errors.

## On the device

The packages live in the `updates` directory of the app's data directory (`process.dataDir`):

| File | What it is |
| --- | --- |
| `next.nshpkg` | Downloaded and verified, not run yet |
| `trying.nshpkg` | Started, on trial |
| `current.nshpkg` | The package that last proved healthy |
| `trust/` | The builds accepted before and the revocations |
| `packages/` | The running package's images and fonts |

| Platform | The app's data directory |
| --- | --- |
| macOS | `~/Library/Application Support/<app id>` |
| Windows | `%APPDATA%\<app id>` |
| Linux | `$XDG_DATA_HOME/<app id>` (`~/.local/share/<app id>`) |
| iOS | `Library/Application Support/nsh/<app id>` in the app's container |
| Android | `files/nsh/<app id>` in the app's internal storage |

### At each start

1. A `trying.nshpkg` still there means the last start never proved healthy: the app crashed or was killed during the
   trial. It is deleted.
2. A `next.nshpkg` is verified again: signed by a release key one of the roots certifies, not revoked, for this app,
   for this runtime, its build higher than the app's own and not older than any build accepted before. It becomes
   `trying.nshpkg` and runs on trial. Refused, it is deleted.
3. Otherwise `current.nshpkg` runs when it still verifies and its build is higher than the app's own; otherwise it is
   deleted.
4. Otherwise the code the app was built with runs.

The app always starts: any problem with a package is logged, and the next choice down runs.

A package runs as the installed app: its id, so the same storage and data, its URL schemes and update source, and at
most the capabilities the installed app declares.

### The trial

A package on trial is healthy once it has run 10 seconds past its first frame, or when the user quits the app before
then. It then becomes `current.nshpkg`, and its build is recorded as accepted. It fails when its code does not load
(an exception at the top level of a module, for example) or its VM is stopped (a memory or time limit): it is
deleted, and the next start runs what ran before. A crash or a forced quit during the trial leaves `trying.nshpkg`
behind, which the next start deletes. An error thrown later, in an event handler for example, is reported as usual and
does not end the trial.

### Rollback protection

An accepted build raises the floor: from then on the app refuses older builds, even ones a trusted key signed, so an
old package with a known bug cannot be made to run again. To withdraw a bad package, publish a newer build with the
fix, and [revoke](./signed-packages.md#revoke-keys-and-packages) the bad one if it must not run anywhere.

## Troubleshooting

### `checkForPackage()` resolves `null`

- The app was built without `"packages": { "roots" }`, or runs from `nsh run` or on the web.
- The manifest has no `"package"`: pass `--package` to `nsh update-manifest`.
- The package's build is not higher than the code the app runs: `runningPackage()`, else the app's own `build`.
- Its `minRuntime` is newer than the app's runtime: publish with the `nsh` the app was built with, or ship a new app.
- On GitHub, the release is a draft or a prerelease, or a newer release without a package is the latest.

It rejects, as `checkForUpdate` does, when the manifest cannot be fetched, is not signed by `publicKey`'s key, or is
for another app.

### `downloadPackage()` rejects

The error starts with `package refused:` and says why:

| Message | Meaning |
| --- | --- |
| `update download: SHA-256 …, the manifest says …` or `… bytes, the manifest says …` | The file on the host is not the one in the manifest: uploaded again, or served stale |
| ``signed by key `…`, which is not trusted`` | The release key's certificate is from a root the app does not trust |
| `the signature does not verify` | The package changed after it was signed |
| `the release key's certificate does not cover this package: …` | The certificate expired or covers other app ids: certify the key again |
| `revoked: …` | The release key or the package is revoked |
| ``app `…` build 13 is older than build 14, which was accepted before`` | Rollback protection: publish a higher build |
| `its build 13 is not newer than the app's 13` | Raise `build` |
| `it is com.example.other, the app is com.example.notes` | The package is another app's |
| `the package needs runtime 0.5.0 or newer; this runtime is 0.4.0` | Publish for the older runtime, or ship a new app |

Nothing is left behind, and the app keeps running what it ran.

### A package does not run at the next start

The launcher logs why, in the terminal or the platform's log (Console or the unified log on Apple platforms,
`adb logcat` on Android):

```text
updates: downloaded package refused: …
updates: the package started last never ran 10s without a fatal error; it is deleted and the app goes back
updates: the installed package does not run: its build 13 is not newer than the app's 20
running package com.example.notes 1.2.1 (build 13), shipped build 12
```

### Try it locally

1. Package and install the app with `"packages": { "roots" }` in `nsh.json`, for example `nsh package --target macos`.
2. Change some TSX, raise `build`, and publish a package. Check it as the app will:

   ```sh
   nsh publish --key keys/release.secret --cert keys/release.cert -o next.nshpkg
   nsh verify next.nshpkg --root keys/root.pub
   ```

3. Put it where a download would, and start the app:

   ```sh
   mkdir -p ~/Library/Application\ Support/com.example.notes/updates
   cp next.nshpkg ~/Library/Application\ Support/com.example.notes/updates/
   ```

   The app runs it on trial; after 10 seconds it is `current.nshpkg`. A package whose `App.tsx` throws at the top level
   tries the rollback: the app reports the error, and the next start runs the code before it.

To try the whole flow, serve `latest.json` and the package from your machine (`"url": "http://127.0.0.1:8000/latest.json"`
with a `publicKey`; plain HTTP is allowed only to this machine) and call `checkForUpdates()`.

## See also

- [Signed Packages](./signed-packages.md): keys, certificates, verification and revocation
- [App Updates](./app-updates.md): updating the whole app
- [nsh/updater](../modules/nsh-updater.md): the API
- [CLI](./cli.md): `nsh publish`, `nsh update-manifest`, `nsh verify`
