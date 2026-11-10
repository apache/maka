# App updates

`nsh/updater` lets a packaged app replace itself. The rules are in `crates/nsh-updater` (no network, no UI), the JS face
in `crates/nsh-core/src/runtime/updater.rs`, the toolchain's side in `crates/nsh-cli/src/updater.rs`; the user guide is
`website/docs/app-updates.md`, the API reference `website/modules/nsh-updater.md`.

## Flow

1. `nsh.json`'s `"updater"` (`github` or `url`, `publicKey`) is checked by `nsh package`, which adds it with the app's
   id and version to the package's assets as `nsh-updater.json`, and leaves `<name>-<version>-<os>-<arch>.<ext>`.
2. `nsh update-manifest` writes `latest.json` and `latest.json.sig` for one version's archives.
3. `checkForUpdate` reads the asset, gets the manifest, checks the signature, the id and that the version is newer.
4. `downloadUpdate` streams the asset into `<data dir>/updates`, checking its size and SHA-256.
5. `installAndRestart` unpacks next to the app, checks the new app, swaps it in, then restarts the app as
   `Application.restart()` does (`DesktopCommand::Restart`): this run quits, and the new version starts once it has
   exited (`nsh_core::restart`).

HTTP is the platform's `Network`, as `fetch`'s, through `UpdaterHost`, which the engine gives `System`: no second HTTP
or TLS stack, and it works on iOS and Android, where `ureq` is not linked. These requests are not subject to the app's
`capabilities.network`: the app's code cannot choose where they go.

## OTA updates

OTA (over-the-air) updates: a release that only changes the app's TSX reaches installed apps, iOS and Android
included, as a signed package (`docs/dev/signed-packages.md`) instead of a new app; only a change to the runtime
needs a new app build. The user guide is `website/docs/ota-updates.md`. "OTA" is the docs' name for this; "hot
update" means the dev server's reload on save (`nsh run`) and is not used for it.

1. `nsh.json` `"updater": { "packages": { "roots": [<root.pub>] } }`: `nsh package` writes the roots and the shipped
   bundle's `build` into `nsh-updater.json` (`Config::packages`, `Config::build`).
2. `nsh update-manifest --package <file.nshpkg>` checks the package (its signature, the app's id, the roots) and
   writes `latest.json`'s `"package"`: `version`, `build`, `url`, `sha256`, `size`, `minRuntime`
   (`PackageAsset`). `platforms` may be empty: a release can be a package alone.
3. `checkForPackage` offers it when its build is newer than the running one (the running package's, else
   `Config::build`) and `minRuntime` is at most this runtime (`Config::check_package`).
4. `downloadPackage` writes `<data dir>/<app id>/updates/next.nshpkg.part`, checks size and SHA-256, verifies it
   with the roots as the launcher will (`UpdaterHost::verify_package`, the engine's
   `updates::verify_download`: signature, certificate, revocations, app id, build, runtime; nothing accepted),
   then renames it to `next.nshpkg`. Any failure removes the part.
5. The launchers (`nsh-{macos,linux,windows,ios}-app`, Android's `AppActivity` through `Native.load`) call
   `nsh_engine::updates::launch` / `package_to_run`. A `trying.nshpkg` left by the last launch crashed: it is
   deleted. A `next.nshpkg` that verifies, is the app's and newer than the shipped build is renamed to
   `trying.nshpkg` and runs on trial ([`Bundle::trial`]); else `current.nshpkg` runs if it still verifies and is
   newer than the shipped build (a newer app removes it); else the shipped bundle. Every failure there is logged and
   runs the shipped bundle.
6. The engine reports the trial: a fatal error (`AppError::is_fatal`) deletes `trying.nshpkg` (the next launch goes
   back); `TRIAL_PERIOD` (10 s) after the first frame, or the engine stopping before (the user quit), it is healthy:
   its build is accepted in the trust store (`updates/trust`) and it becomes `current.nshpkg`. A process crash tells
   nothing, so the file stays and the next launch goes back.
7. `restartToPackage` restarts as `Application.restart()` on the desktop; iOS and Android reject with
   `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` and the package runs at the next cold start.

A package runs as the installed app: the shipped app's id (a package of another id is refused), URL schemes,
trusted paths and update configuration (`Bundle::updater_config`: `nsh/updater` reads the shipped
`nsh-updater.json`, never the package's), and its own declared capabilities granted at most what the shipped app
declares (`Policy::granted`). Its assets are its own (extracted to `updates/packages/<id>/<sha256>/assets`; the other
packages' are removed at launch). `runningPackage()` is `Bundle::package`. `shellInfo()` is the installed app
(its shell): the shipped `nsh-updater.json`'s `version` and `build` (what `nsh package` also wrote as the iOS
`CFBundleShortVersionString` / `CFBundleVersion`), the runtime's crate version, and `UpdaterHost::runs_packages`.

## Decisions

- **The source comes from the package, not the caller.** Otherwise app code, or a plugin, could point the update at
  anything.
- **A plugin cannot replace its host.** `Installation::current` needs the executable beside an `app.json` of the id and
  a `nsh-updater.json` with the same bytes the module read. A plugin has other assets, and if it had the same bytes it
  would only update from the host's own source.
- **Signing.** `SHA-256` in the manifest does not help if the host is compromised, since the manifest comes from the
  same place. A custom host therefore needs `publicKey`; GitHub may have one. The signature has its own context, so a
  signature over a manifest is not valid as anything else signed by a `nsh keygen` key, or the other way around.
- **`releases/latest/download/`, not the GitHub API.** No 60 requests per hour limit, and it skips drafts and
  prereleases. The archives' relative URLs resolve next to it.
- **Swapping.** Linux and macOS rename the whole directory or `.app`, which keeps a user's own name for it. Windows
  cannot rename a directory holding the running executable, but can rename the executable: `swap_entries` swaps entry
  by entry, undoes on failure, and the next check removes what was still in use.
- **Restarting** is `Application.restart()`'s path, the one way an NSH app starts again: the app quits as the user's
  quit does (storage written, windows closed), and the new version starts only after this process has exited, so the
  two never run side by side. Everything that can refuse the new app (its id, its executable, its signature) is
  checked before the swap; after it the app is the new one, whether or not it starts.
- **macOS** checks the new app with `codesign --verify --deep --strict` and starts it with `open -n`. Whether Gatekeeper
  accepts it is the developer's signing and notarization.
- **No Cargo feature.** `zip`, `tar`, `semver` and `nsh-updater` add about 125 KB to a 51 MB Linux runner (`nm -S`), and
  `sha2`, `ed25519-dalek` and `flate2` are linked already. `nsh-updater` is not a dependency in WebAssembly, where
  `checkForUpdate` resolves `null`.
- **Rust apps** (`nsh.json` `"root"`) have no JS modules: they use `nsh-updater` directly and bring their own HTTP.
  After verifying the archive, they call `Installation::install`, then `nsh_core::element::desktop::restart()` as
  `installAndRestart` does.
- **Concurrent calls** are refused while a check, download or install is in progress. Downloads use exclusively
  created unique files, so a retry cannot truncate a previously verified archive.
- **Packages run on trial, by file name.** Renaming `next.nshpkg` to `trying.nshpkg` marks the trial in one step, and
  a download during a trial writes `next.nshpkg` without touching the package that runs. Accepting only once healthy
  keeps the rollback floor (`TrustStore::accept_receipt`) at a build that ran.
- **A package is never wider than the app.** Its capabilities are granted at most the shipped app's, its id must be the
  shipped app's, and the update source and roots come from the shipped app, so a package cannot redirect later
  updates.
- **Public records** (`Config`, `Manifest`, `Asset`, `Available`, `Packages`, `PackageAsset`, `AvailablePackage`) are non-exhaustive and implement `Default`, so later
  fields do not require applications to change exhaustive struct literals.

## Limits

- iOS and Android only check and report a link (`--link`): stores do not allow replacing the binary, and installing an
  APK needs a permission an SDK must not declare for its hosts. OTA packages of the app's code update there.
- No in-process reload into a downloaded package: it runs from the next start (`restartToPackage` on the desktop).
- Downgrades are refused by the version check; a signed manifest of an older version is therefore harmless.
- `nsh#914`: desktop TLS uses the webpki roots, so a custom host on a certificate chain they lack fails to connect.
