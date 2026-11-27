---
title: nsh/updater
description: "A packaged app updates itself: check the source nsh.json names, download the archive with progress, replace the app and restart, or run a newer signed package of its code."
order: 12.7
---

# nsh/updater

`nsh/updater` checks for a newer version of a packaged app, downloads it and replaces the app. Where updates come
from is set in [`nsh.json`'s `"updater"`](#nshjson), never by the code that calls the module, and every step is checked
in Rust: the manifest's signature, a newer version, the archive's size and SHA-256. `promptForUpdate()` asks the
user in a built-in prompt; for a UI of your own, the other functions return state and do the work.
[App Updates](../docs/app-updates.md) walks through the whole flow, from setting the source to publishing a release.

It also updates the app's code alone: a [signed package](../docs/signed-packages.md) of a newer build, which the app
runs from its next start on every native platform, iOS and Android included ([OTA updates](#ota-updates)).

```tsx
import { promptForUpdate } from "nsh/updater";
import { checkForUpdate, downloadUpdate, installAndRestart, installOnQuit } from "nsh/updater";
import { checkForPackage, downloadPackage, restartToPackage, runningPackage, shellInfo } from "nsh/updater";
```

The module can be imported on every platform:

| Platform | `checkForUpdate` | `downloadUpdate`, `installAndRestart`, `installOnQuit` | Packages |
| --- | --- | --- | --- |
| macOS, Windows, Linux (packaged) | Checks the source | Download and replace the app | Check, download, `restartToPackage` restarts into it |
| iOS, Android | Checks the source; `url` is the store link (`nsh update-manifest --link`) | Reject: send the user to `url` | Check and download; the package runs from the next start |
| Web, development runs, apps without `"updater"` | Resolves `null` | Reject | `checkForPackage` resolves `null`, `runningPackage()` is `null`, `shellInfo()` has no `version` |

It needs no capability: `capabilities.network` does not apply, since the app's code cannot choose where these requests
go. Its requests use the platform's own network stack, as `fetch` does.

## promptForUpdate

```ts
function promptForUpdate(options?: UpdatePromptOptions | null): Promise<void>;

interface UpdatePromptOptions {
  channel?: string | null;
  locale?: string | null;
  quiet?: boolean | null;
}
```

Checks for a newer version as [`checkForUpdate`](#checkforupdate) does (`channel` and `locale` are its options) and
asks the user in NSH's built-in prompt, as macOS apps' Sparkle does: the new version, its release notes, "Skip This
Version", "Remind Me Later" and "Install Update", then the download's progress and "Install and Relaunch" or "Install on
Quit". On the desktops it is a small window of its own; on iOS and Android, where `canInstall` is false, it is the
system's alert, and "Update" opens the update's `url`. Its look is fixed.

The prompt keeps the user's "Skip This Version" and "Automatically download and install updates in the future" in the
app's data directory. With `quiet: true`, for a check at startup or in the background, nothing shows when the app is up
to date, the check fails or the user skipped the version, and once the user chose automatic updates the update downloads
and installs as the app quits without asking. Without it, for a "Check for Updates…" menu item, the user also hears
that the app is up to date or that the check failed. It resolves once the prompt shows or there is nothing to show, and
never rejects.

```tsx
promptForUpdate({ quiet: true }); // at startup
<Button onPress={() => promptForUpdate()}><Text>Check for Updates…</Text></Button>;
```

The prompt's text is English. The app's name comes from `nsh.json`'s `"name"`.

## checkForUpdate

```ts
function checkForUpdate(options?: UpdateCheckOptions | null): Promise<AppUpdate | null>;

interface UpdateCheckOptions {
  channel?: string | null;
  locale?: string | null;
}

interface AppUpdate {
  version: string;
  notes?: string | null;
  url: string;
  canInstall: boolean;
  shell: boolean;
}
```

Fetches the manifest from the source in `nsh.json` and resolves the newer version it describes, or `null` when the app
is up to date, has no `"updater"`, or runs where apps do not update (the web, `nsh run`). It compares the installed
app's own version, the one it shipped as. A run on a [package](#checkforpackage) of that version or a later one still
gets the update, with `shell` true: its code is already the release's, and only the installed app (the runtime and
native shell) is behind.

| Field | Meaning |
| --- | --- |
| `version` | The new version, semver |
| `notes` | What changed, as the manifest's `--notes` file says it; with `locale`, its notes in that language (or its base language, `zh` for `zh-TW`) when it has them, downloading only that file |
| `url` | Where the user can get it by hand: the archive, or the store page on iOS and Android. Pass it to [`openUrl`](./nsh.md#openurl) when `canInstall` is false |
| `canInstall` | Whether `downloadUpdate`, `installAndRestart` and `installOnQuit` work in this run: a packaged desktop app installed where the user can write. False on iOS and Android, and under a directory only the system writes (a system package) |
| `shell` | Whether only the installed app is behind: this run's [package](#checkforpackage) is already this version or later, so the update brings a newer runtime and native shell, not newer code. Apps that update by package can offer it as a quieter, optional step |

It rejects when the source cannot be reached or its manifest is not acceptable: a bad or missing signature when
`publicKey` is set, a URL that is not HTTPS. A manifest of the same or an older version is not an
update, so a stale manifest cannot downgrade the app.

`channel` checks one of the [channels](#channels) `nsh.json` names instead of the default source. It is a name, never
an address: a name the package does not declare rejects before any request. `downloadUpdate` and `installAndRestart`
use what the last check found, whichever source it read.

`locale` is the language the app shows, a BCP 47 tag such as `zh-TW`, which may differ from the system's. When the
manifest has notes in it (`nsh update-manifest --notes zh-TW=<file>`), or in its base language (`zh`), `notes` is
those: only that file is downloaded and checked against the SHA-256 in the signed manifest. Otherwise, and when that
file cannot be had, `notes` is the manifest's default notes. `checkForPackage` takes `locale` too.

### Channels

An app that offers early releases to the users who opt in declares a second manifest in `nsh.json`
(`"channels": { "beta": "<url>" }`) and passes the user's choice to each check:

```tsx
const update = await checkForUpdate(wantsBeta() ? { channel: "beta" } : undefined);
```

Every channel is checked as the default source is: the same `publicKey`, and only a newer version is
offered. Leaving a channel therefore never goes back: an app on `1.3.0-beta.2` that checks the default source again is
offered `1.3.0`, not `1.2.0`. Publish each channel's manifest with `nsh update-manifest` as usual; a channel's
archives' relative URLs resolve next to its own manifest.

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
against the manifest. An interrupted download keeps its partial file keyed to the asset and resumes on the next call
with an HTTP `Range` request when the server supports it, restarting from the beginning if the server ignores the range
or the asset changed. A dropped connection, a body that stalls for 60 seconds, a truncated response or a `5xx`/`408`/`429` is retried on its own from the bytes already on disk, waiting longer between tries, and fails after five tries in a row that bring no new bytes. It rejects with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` when no update was found or `canInstall` is
false, and when the download fails or does not match.

```tsx
const progress = signal(0);
await downloadUpdate(({ received, total }) => progress.set(total ? received / total : 0));
```

## installAndRestart

```ts
function installAndRestart(): Promise<void>;
```

Unpacks the downloaded archive next to the app, checks the new app (one runnable app, and on macOS its code
signature; its id and name may change), swaps it in and restarts the app as `Application.restart()` does: this run quits as when the user quits
it, and the new version starts once it has exited. The promise settles only on failure, which leaves the installed app
as it was: it rejects when nothing was downloaded or the app cannot be replaced.

On Linux and macOS the whole directory or `.app` is replaced, keeping the name the user gave it; on Windows the files
are replaced one by one and put back if one fails.

## installOnQuit

```ts
function installOnQuit(): Promise<void>;
```

Replaces the app with the downloaded update when the app quits, without starting it again: the user's next start opens
the new version. For an "Install on Quit" button beside "Install and Relaunch". The archive is unpacked next to the app
and checked now, as `installAndRestart` checks it, and the promise resolves once the update waits; quitting then only
moves it into place. It rejects when nothing was downloaded, with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` when
`canInstall` is false, and when the update is refused, which leaves the app as it was.

Calling it again replaces the update that waits (call it after downloading a newer one), and `installAndRestart`
installs at once instead. An app that quits normally installs it, also when it quits to restart
(`Application.restart()`, which then starts the new version); a crash or a kill does not, and the next `checkForUpdate`
offers the update again. If moving it into place fails as the app quits (the user moved the app meanwhile), the app
stays as it was and quits all the same; the failure is logged.

```tsx
await downloadUpdate();
await installOnQuit(); // the app keeps running; the new version opens next time
```

## OTA updates

OTA (over-the-air) updates deliver a packaged app's TSX as a signed package (`nsh publish`) instead of a new app.
[OTA Updates](../docs/ota-updates.md) walks through the setup, the release and what happens on the device. An app whose
`nsh.json` trusts package roots (`"updater": { "packages": { "roots": [...] } }`, [below](#nshjson)) finds it in the
same manifest, downloads it, and runs it from its next start. A change to the NSH runtime itself still needs a new app
build: each package names the lowest runtime it runs on, and older apps are not offered it.

### checkForPackage

```ts
function checkForPackage(options?: {
  locale?: string | null;
  url?: string | null;
}): Promise<PackageUpdate | null>;

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

`url` checks that manifest instead, for an app built with `"packages": { "source": "runtime" }`
([A feed chosen at run time](../docs/ota-updates.md#a-feed-chosen-at-run-time)). The signatures are checked against the
keys in `nsh.json` as for any source, and `downloadPackage` downloads what this check found. It rejects for an app
without `"source": "runtime"`, for a URL that is not HTTPS (or plain HTTP with `"allowHttp": true`), and for a URL with
a user name or password. An app with `"source": "runtime"` and no `github` or `url` must pass `url`.

### downloadPackage

```ts
function downloadPackage(onProgress?: ((progress: UpdateProgress) => void) | null): Promise<void>;
```

Downloads the package the last `checkForPackage` found, checks its size and SHA-256 against the manifest, and
verifies it as the app's next start will: signed by a release key one of the roots certifies, for this app, newer
than the running build and than every build the app ran before, for this runtime. It then waits in the app's data
directory for the next start. An interrupted download keeps its partial file keyed to the package and resumes on the
next call with an HTTP `Range` request when the server supports it, restarting from the beginning if the server ignores
the range or the package changed. A dropped connection, a body that stalls for 60 seconds, a truncated response or a `5xx`/`408`/`429` is retried on its own from the bytes already on disk, waiting longer between tries, and fails after five tries in a row that bring no new bytes. It rejects with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` when the check found none, and
with an error saying why (`package refused: …`) when the download fails or the package is refused (a refused package
leaves nothing behind).

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
file; with it, unsigned manifests are refused. `channels` names other manifests the app's code may
[choose by name](#channels).

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
| `channels` | object | Channel name (letters, digits, `-`, `_`, `.`) to the HTTPS URL of its manifest, for `checkForUpdate({ channel })`. Requires `publicKey` |
| `publicKey` | string | The Ed25519 key that signs the manifests (`latest.json.sig`). Required with `url` and `channels` |
| `packages.roots` | string[] | Root public keys (`nsh keygen`'s `root.pub`) whose certified release keys sign the app's [OTA packages](#ota-updates). Without it the app runs no packages |
| `packages.source` | `"runtime"` | The app's code names the package manifest at each check: `checkForPackage({ url })`. Requires `publicKey`; `github` and `url` become optional |
| `packages.allowHttp` | boolean | With `source: "runtime"`: the feed may be plain HTTP. Its signature, notes, package and redirects stay on its origin |

`nsh package` checks the keys and adds them, with the app's `build`, to the package, so the source is fixed when the
app is built. `version` must be
semver. `nsh update-manifest` writes `latest.json` and its signature for one release's archives and package
([CLI](../docs/cli.md#nsh-update-manifest)).

## Rust

Rust apps (`nsh.json` `"root"`) show the same prompt with `nsh_core::runtime::prompt_for_update`, to spawn as a task:

```rust
use nsh_core::runtime::{UpdatePromptOptions, prompt_for_update};

spawn(prompt_for_update(UpdatePromptOptions::default().quiet(true)));
```

For a flow of their own they use the `nsh-updater` crate directly with an HTTP client of their own:
`Config::check` verifies the manifest, `Download` the archive, `Installation::install` replaces the app, and
`nsh_core::element::desktop::restart()` starts the new version ([App Updates](../docs/app-updates.md#rust-apps)).
