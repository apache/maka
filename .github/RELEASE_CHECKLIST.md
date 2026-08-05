# Desktop release checklist

The `Release desktop` workflow is the single release entry point. It packages, verifies, and creates one draft GitHub Release carrying the Apple Silicon macOS and Windows x64 builds; it never publishes the release. The macOS build is signed, notarized, and stapled. The Windows build is unsigned.

## One-time repository setup

Create a GitHub Environment named `release`. Add required reviewers if the repository needs a release approval gate, then configure these environment secrets:

- `CSC_LINK`: base64-encoded Developer ID Application `.p12`;
- `CSC_KEY_PASSWORD`: password for that `.p12`;
- `APPLE_API_KEY`: raw contents of an App Store Connect API `.p8` key;
- `APPLE_API_KEY_ID`: App Store Connect API key ID;
- `APPLE_API_ISSUER`: App Store Connect API issuer ID.

Windows needs no secrets while the build is unsigned: electron-builder skips signing when no certificate is configured. Adding an Authenticode certificate later means configuring it in `apps/desktop/electron-builder.config.mjs`, and nothing else: electron-builder derives the publisher name that authenticates updates from the certificate itself.

## Create the draft

1. Confirm the intended commit is on `main`, CI is green, and `apps/desktop/package.json` contains a version that has never been released.
2. In GitHub Actions, run `Release desktop` against `main`.
3. Confirm every workflow step passes on both platforms and a draft release named `v<version>` exists.
4. Confirm the draft records the intended commit SHA and contains the macOS DMG, ZIP, `latest-mac.yml`, the Windows `.exe`, ZIP, `latest.yml`, and a `.sha256` file for the DMG, the `.exe`, and the Windows ZIP.

## Acceptance on another Apple Silicon Mac

Download the DMG and its `.sha256` file through the GitHub UI. This download path applies the real browser quarantine metadata that CI intentionally does not simulate.

1. From the download directory, run `shasum -a 256 -c Maka-<version>-mac-arm64.dmg.sha256`.
2. Open the DMG in Finder, drag Maka to Applications, and launch it from Finder.
3. Confirm macOS opens Maka without an unidentified-developer or damaged-app warning.
4. Run `spctl --assess --type execute --verbose=4 /Applications/Maka.app` and confirm it is accepted with a Developer ID origin.
5. Configure a model connection, send one basic prompt, and run one representative file-tool task.
6. Install `ripgrep` with `brew install ripgrep`, then confirm a task using `Grep` works.
7. Confirm the known limitation is accurate: Computer Use is not included.

## Acceptance on a Windows x64 machine

Download the `.exe` installer and its `.sha256` file through the GitHub UI. The build is unsigned, so this pass is about confirming the expected warnings and that the app still runs.

1. From the download directory, run `Get-FileHash Maka-<version>-win-x64.exe -Algorithm SHA256` in PowerShell and confirm the hash matches the `.sha256` file.
2. Run the installer. Confirm SmartScreen shows the expected unrecognized-publisher warning, and that continuing through **More info → Run anyway** completes the install.
3. Launch Maka from the Start menu.
4. Configure a model connection, send one basic prompt, and run one representative file-tool task.
5. Install `ripgrep` with `winget install BurntSushi.ripgrep.MSVC`, restart Maka so the new `PATH` applies, then confirm a task using `Grep` works.
6. Run one terminal task and confirm the shell integration works against the packaged `node-pty`.
7. Confirm the known limitation is accurate: Computer Use is not included.

Publish the draft only after all checks pass on both platforms. If acceptance fails, keep the draft unpublished, fix the issue, increment the desktop version, and run the workflow again; do not replace an existing release identity.
