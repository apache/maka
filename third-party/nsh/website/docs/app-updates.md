---
title: App Updates
description: "Let a packaged app update itself: from GitHub Releases or your own host, with signed manifests and verified downloads."
order: 20.5
group: delivery
---

# App Updates

`nsh/updater` lets a packaged app check for a newer version, download it and replace itself. The UI is yours: the module
gives you the state and the actions. It updates the whole app; to update only a packaged app's TSX, see
[OTA Updates](/docs/ota-updates), and to deliver only NSH screens to a host app, see
[Signed Packages](/docs/signed-packages).

| Platform | What it does |
| --- | --- |
| macOS, Windows, Linux | Checks, downloads, replaces the app and restarts it |
| iOS, Android | Checks, and gives you the link to send the user to |
| Web | Nothing to do: a deploy updates the app, `checkForUpdate` resolves `null` |
| Every native platform | Runs a newer TSX release as a signed package ([OTA updates](#ota-updates)) |

## Set the source

From GitHub Releases, in `nsh.json`:

```json
{ "version": "1.2.0", "updater": { "github": "owner/repo" } }
```

From your own host, which needs a signing key, because whoever controls the host would otherwise control what your app
runs (`nsh keygen keys/update`, keep the `.secret` out of your repository):

```json
{
  "version": "1.2.0",
  "updater": {
    "url": "https://dl.example.com/app/latest.json",
    "publicKey": "<contents of keys/update.pub>"
  }
}
```

`publicKey` also works with `github`: unsigned manifests are then refused.

To offer a beta to the users who opt in, add a channel: another manifest, by name. The app's code passes the user's
choice as a name (`checkForUpdate({ channel: "beta" })`), never an address, so the package still decides where updates
come from ([channels](../modules/nsh-updater.md#channels)).

```json
"updater": {
  "url": "https://dl.example.com/app/latest.json",
  "channels": { "beta": "https://dl.example.com/app/beta/latest.json" },
  "publicKey": "<contents of keys/update.pub>"
}
```

## Use it

```tsx
import { checkForUpdate, downloadUpdate, installAndRestart } from "nsh/updater";
import { openUrl } from "nsh";

const update = await checkForUpdate(); // null when up to date
if (update?.canInstall) {
  await downloadUpdate(({ received, total }) => setProgress(received / (total ?? 1)));
  await installAndRestart();
} else if (update) {
  await openUrl(update.url);
}
```

`update` has `version`, `notes`, `url` and `canInstall`. `canInstall` is false on iOS and Android, and on the desktop when
the app is installed where the user cannot write, such as by a system package. In a development run `checkForUpdate`
resolves `null`.

`installAndRestart` restarts the app as `Application.restart()` does: this run quits as when the user quits it, and
the new version starts once it has exited. If it fails, the app stays as it was. To install without interrupting the
user, call `installOnQuit()` instead: the update is checked now and replaces the app when it quits, and the next start
opens the new version. The
[nsh/updater reference](../modules/nsh-updater.md) has every function, its errors and the `nsh.json` keys.

## Publish a release

`version` in `nsh.json` must be [semver](https://semver.org) and grow with each release. With `"updater"` set,
`nsh package` also writes an archive named for its platform. Package on each platform, then write the manifest:

```sh
nsh package --target linux   # My-App-1.3.0-linux-x86_64.tar.gz
nsh package --target macos   # My-App-1.3.0-macos-aarch64.tar.gz
nsh package --target windows # My-App-1.3.0-windows-x86_64.zip

nsh update-manifest *.tar.gz *.zip \
  --notes CHANGES.md \
  --key keys/update.secret \
  --link ios=https://apps.apple.com/app/id000000000
```

Upload the archives, `latest.json` and `latest.json.sig` (with `--key`) as assets of the GitHub Release, or to your host
next to each other. A release marked as a draft or prerelease on GitHub is not offered.

For notes in more than one language, add `--notes <tag>=<file>` for each, a BCP 47 tag such as
`--notes zh-TW=CHANGES.zh-TW.md`. Each is written as `notes.<tag>.md` beside `latest.json`, which records its SHA-256;
upload them with it. Check with `checkForUpdate({ locale })` and `update.notes` is the one in that language, downloaded
alone, or the untagged notes when there is none. Apps on older runtimes keep showing the untagged notes.

### Smaller downloads

Pass the previous release's archives with `--previous` and `nsh update-manifest` writes a zstd patch per platform,
from that version to this one, beside the manifest; upload them too. An app running the previous version downloads the
patch instead of the archive, rebuilds the new app from its installed files and installs it as usual. It falls back
to the whole archive when its files are not the released ones, the patch fails, or its result does not match the
SHA-256 in the signed manifest. Apps on older versions, or older runtimes, download the archive as before.

```sh
gh release download v1.2.0 -p 'My-App-1.2.0-*' -D previous
nsh update-manifest *.tar.gz *.zip --previous previous/* --notes CHANGES.md --key keys/update.secret
```

On NSH's own release packages a patch between adjacent versions is 24–37% of the archive. Making one takes about a
minute and up to 0.7 GB of memory per platform, so do it in the release CI; applying one takes well under a second.

## OTA updates

A release that changes only the app's TSX needs no new app: [OTA updates](/docs/ota-updates) deliver it as a signed
package that installed apps run from their next start, on every native platform, iOS and Android included. Use them
first, and a new app when the change needs a newer NSH runtime or native code. One manifest can carry both, and the
app checks for a package before a new app:

```tsx
import { checkForPackage, checkForUpdate, downloadPackage } from "nsh/updater";

if (await checkForPackage()) {
  await downloadPackage(); // runs from the next start
} else {
  const update = await checkForUpdate();
  // …as above
}
```

[OTA Updates](/docs/ota-updates) covers the keys, the `"packages"` setting, releases from CI and what happens on the
device.

## What is checked

- The manifest's signature, when there is a `publicKey`.
- The version: only a newer one is offered, so an old manifest cannot downgrade the app.
- URLs: HTTPS only (plain HTTP only to this machine, for local tests).
- The archive's size and SHA-256.
- The new app: one runnable app (its executable, and on macOS its code signature). Its id and executable name may
  differ from the installed app's, so an update can rename the app or move it to a new id: the manifest's signature is
  what binds an update to the app. Apps sharing a signing key install whatever their `"updater"` source serves.
- That this run is the package itself: an NSH module running inside another app cannot replace it.
- An OTA package: its signature against `packages.roots`, the app id, a build newer than the running one
  and than any the app ran before, the runtime it needs, its size and SHA-256.

On macOS, `nsh package` signs ad hoc, which is fine to test, but Gatekeeper may stop it on other Macs. To distribute, sign
the `.app` with your Developer ID, notarize it, and archive it again under the same name (`tar -czf <archive> <Name>.app`)
before `nsh update-manifest`.

## Rust apps

A native Rust app uses `nsh-updater` directly and supplies its own HTTP transport.
Use `Config::check` to verify the manifest and `Download` to verify the archive.
Then call `Installation::install` and, when it succeeds,
`nsh_core::element::desktop::restart()`: the app quits as `Application.restart()`
makes it, and the new version starts once this process has exited. If `install`
fails, the app stays as it was.

The `Config`, `Manifest`, `Asset` and `Available` records are non-exhaustive.
Construct them with `Default::default()` and assign the fields you need.
