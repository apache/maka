---
title: nsh/updater
description: "A packaged app updates itself: check the source nsh.json names, download the archive with progress, replace the app and restart, or run a newer signed package of its code."
order: 12.7
---

# nsh/updater

`nsh/updater` checks for a newer version of a packaged app, downloads it and replaces the app. Where updates come
from is set in [`nsh.json`'s `"updater"`](#nshjson), never by the code that calls the module, and every step is checked
in Rust: the manifest's signature, the app id, a newer version, the archive's size and SHA-256. The UI is yours: the
module returns state and does the work.
[App Updates](../docs/app-updates.md) walks through the whole flow, from setting the source to publishing a release.

It also updates the app's code alone: a [signed package](../docs/signed-packages.md) of a newer build, which the app
runs from its next start on every native platform, iOS and Android included ([OTA updates](#ota-updates)).

```tsx
import { checkForUpdate, downloadUpdate, installAndRestart } from "nsh/updater";
import { checkForPackage, downloadPackage, restartToPackage, runningPackage, shellInfo } from "nsh/updater";
```

The module can be imported on every platform:

| Platform | `checkForUpdate` | `downloadUpdate`, `installAndRestart` | Packages |
| --- | --- | --- | --- |
| macOS, Windows, Linux (packaged) | Checks the source | Download and replace the app | Check, download, `restartToPackage` restarts into it |
| iOS, Android | Checks the source; `url` is the store link (`nsh update-manifest --link`) | Reject: send the user to `url` | Check and download; the package runs from the next start |
| Web, development runs, apps without `"updater"` | Resolves `null` | Reject | `checkForPackage` resolves `null`, `runningPackage()` is `null`, `shellInfo()` has no `version` |

It needs no capability: `capabilities.network` does not apply, since the app's code cannot choose where these requests
go. Its requests use the platform's own network stack, as `fetch` does.

## checkForUpdate

```ts
function checkForUpdate(): Promise<AppUpdate | null>;

interface AppUpdate {
  version: string;
  notes?: string | null;
  url: string;
  canInstall: boolean;
}
```

Fetches the manifest from the source in `nsh.json` and resolves the newer version it describes, or `null` when the app
is up to date, has no `"updater"`, or runs where apps do not update (the web, `nsh run`). A run on a
[package](#checkforpackage) of that version or a later one is up to date too: the app's own version stays the one it
shipped as, but its code is already the release's.

| Field | Meaning |
| --- | --- |
| `version` | The new version, semver |
| `notes` | What changed, as the manifest's `--notes` file says it |
| `url` | Where the user can get it by hand: the archive, or the store page on iOS and Android. Pass it to [`openUrl`](./nsh.md#openurl) when `canInstall` is false |
| `canInstall` | Whether `downloadUpdate` and `installAndRestart` work in this run: a packaged desktop app installed where the user can write. False on iOS and Android, and under a directory only the system writes (a system package) |

It rejects when the source cannot be reached or its manifest is not acceptable: a bad or missing signature when
`publicKey` is set, another app's id, a URL that is not HTTPS. A manifest of the same or an older version is not an
update, so a stale manifest cannot downgrade the app.

## downloadUpdate

```ts
function downloadUpdate(onProgress?: ((progress: UpdateProgress) => void) | null): Promise<void>;

interface UpdateProgress {
  received: number;
  total?: number | null;
}
```

Downloads the archive of the update the last `checkForUpdate` found into the app's data directory, calling
`onProgress` as bytes arrive (`total` is missing when the server does not say), then checks its size and SHA-256
against the manifest. It rejects with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` when no update was found or `canInstall` is
false, and when the download fails or does not match.

```tsx
const progress = signal(0);
await downloadUpdate(({ received, total }) => progress.set(total ? received / total : 0));
```

## installAndRestart

```ts
function installAndRestart(): Promise<void>;
```

Unpacks the downloaded archive next to the app, checks the new app (its id and executable, and on macOS its code
signature), swaps it in and restarts the app as `Application.restart()` does: this run quits as when the user quits
it, and the new version starts once it has exited. The promise settles only on failure, which leaves the installed app
as it was: it rejects when nothing was downloaded or the app cannot be replaced.

On Linux and macOS the whole directory or `.app` is replaced, keeping the name the user gave it; on Windows the files
are replaced one by one and put back if one fails.

## OTA updates

OTA (over-the-air) updates deliver a packaged app's TSX as a signed package (`nsh publish`) instead of a new app.
[OTA Updates](../docs/ota-updates.md) walks through the setup, the release and what happens on the device. An app whose
`nsh.json` trusts package roots (`"updater": { "packages": { "roots": [...] } }`, [below](#nshjson)) finds it in the
same manifest, downloads it, and runs it from its next start. A change to the NSH runtime itself still needs a new app
build: each package names the lowest runtime it runs on, and older apps are not offered it.

### checkForPackage

```ts
function checkForPackage(): Promise<PackageUpdate | null>;

interface PackageUpdate {
  version: string;
  build: number;
  notes?: string | null;
  size?: number | null;
}
```

Fetches the manifest as `checkForUpdate` does and resolves the package it offers when its build is newer than the
running one (the running package's, else the build the app shipped with) and this runtime runs it. It resolves `null`
when there is none, the app trusts no package roots, or it runs where apps do not update (the web, `nsh run`). It
rejects as `checkForUpdate` does.

### downloadPackage

```ts
function downloadPackage(onProgress?: ((progress: UpdateProgress) => void) | null): Promise<void>;
```

Downloads the package the last `checkForPackage` found, checks its size and SHA-256 against the manifest, and
verifies it as the app's next start will: signed by a release key one of the roots certifies, for this app, newer
than the running build and than every build the app ran before, for this runtime. It then waits in the app's data
directory for the next start. It rejects with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` when the check found none, and
with an error saying why (`package refused: …`) when the download fails or the package is refused, which leaves
nothing behind.

### restartToPackage

```ts
function restartToPackage(): Promise<void>;
```

On macOS, Windows and Linux, restarts the app into the downloaded package as `Application.restart()` does; the promise
settles only on failure. It rejects when nothing was downloaded, and on iOS and Android with
`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`: there the package runs from the app's next start.

### runningPackage

```ts
function runningPackage(): RunningPackage | null;

interface RunningPackage {
  version: string;
  build: number;
}
```

The package this run's code came from, or `null` when the app runs the code it shipped with.

### shellInfo

```ts
function shellInfo(): ShellInfo;

interface ShellInfo {
  version: string | null;
  build: number | null;
  nshVersion: string;
  packages: boolean;
}
```

The installed app this code runs in, its shell: the `version` and `build` it was packaged with (`nsh.json`'s; on iOS
its `CFBundleShortVersionString` and `CFBundleVersion`), the version of the NSH runtime built into it, and whether it
runs signed packages. A package replaces the app's code, not its shell: `runningPackage()` says which code runs,
`shellInfo()` what runs it, so a package that needs a newer runtime (`minRuntime`) tells the user to install the
whole app. `version` and `build` are `null` for an app without `"updater"` in `nsh.json`, and on the web and in
development runs, where `packages` is `false`.

### At the next start

The app runs the newest package that verifies and is newer than the build it shipped with. The first run of a new
package is a trial: once it has run 10 seconds past its first frame, or the user quits it, it becomes the installed
package. If it fails to start or its VM stops, or the app crashes before, the app goes back to the package it ran
before (or the code it shipped with) and deletes the new one. A package runs as the installed app: its id, URL
schemes and update source, and at most the capabilities the installed app declares. An app update with a newer build
replaces the packages of older builds.

```tsx
import { checkForPackage, downloadPackage, restartToPackage } from "nsh/updater";

const found = await checkForPackage();
if (found) {
  await downloadPackage();
  // Desktop: restart now. iOS and Android: it runs from the next start.
  await restartToPackage().catch(() => {});
}
```

## Calls in progress

One check, download or install runs at a time: calling any of them while another is in progress rejects. Disable the
button while one runs.

```tsx
import { openUrl, signal } from "nsh";
import { checkForUpdate, downloadUpdate, installAndRestart, type AppUpdate } from "nsh/updater";

const update = signal<AppUpdate | null>(null);
const busy = signal(false);

async function run<T>(work: () => Promise<T>) {
  busy.set(true);
  try {
    return await work();
  } finally {
    busy.set(false);
  }
}

export const check = () => run(async () => update.set(await checkForUpdate()));

export const install = () =>
  run(async () => {
    const found = update();
    if (!found) return;
    if (!found.canInstall) return openUrl(found.url);
    await downloadUpdate();
    await installAndRestart();
  });
```

## nsh.json

`"updater"` names one source: `github`, an `owner/repo` whose latest GitHub Release holds `latest.json`, or `url`, the
manifest on a host of your own, which requires `publicKey`. `publicKey` is the contents of an `nsh keygen` `.pub`
file; with it, unsigned manifests are refused.

```json
{
  "id": "com.example.notes",
  "version": "1.2.0",
  "updater": { "github": "example/notes", "publicKey": "<contents of keys/update.pub>" }
}
```

| Key | Type | Meaning |
| --- | --- | --- |
| `github` | string | `owner/repo`: the manifest is the asset `latest.json` of its latest release. Drafts and prereleases are skipped |
| `url` | string | The manifest's HTTPS URL on your own host; archives' relative URLs resolve next to it |
| `publicKey` | string | The Ed25519 key that signs the manifests (`latest.json.sig`). Required with `url` |
| `packages.roots` | string[] | Root public keys (`nsh keygen`'s `root.pub`) whose certified release keys sign the app's [OTA packages](#ota-updates). Without it the app runs no packages |

`nsh package` checks the keys and adds them, with the app's `build`, to the package, so the source is fixed when the
app is built. `version` must be
semver. `nsh update-manifest` writes `latest.json` and its signature for one release's archives and package
([CLI](../docs/cli.md#nsh-update-manifest)).

## Rust

Rust apps (`nsh.json` `"root"`) use the `nsh-updater` crate directly with an HTTP client of their own:
`Config::check` verifies the manifest, `Download` the archive, `Installation::install` replaces the app, and
`nsh_core::element::desktop::restart()` starts the new version ([App Updates](../docs/app-updates.md#rust-apps)).
