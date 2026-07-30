# macOS arm64 release checklist

The `Release macOS arm64` workflow is the single release entry point. It packages, signs, notarizes, verifies, and creates a draft GitHub Release; it never publishes the release.

## One-time repository setup

Create a GitHub Environment named `release`. Add required reviewers if the repository needs a release approval gate, then configure these environment secrets:

- `CSC_LINK`: base64-encoded Developer ID Application `.p12`;
- `CSC_KEY_PASSWORD`: password for that `.p12`;
- `APPLE_API_KEY`: raw contents of an App Store Connect API `.p8` key;
- `APPLE_API_KEY_ID`: App Store Connect API key ID;
- `APPLE_API_ISSUER`: App Store Connect API issuer ID.

## Create the draft

1. Confirm the intended commit is on `main`, CI is green, and `apps/desktop/package.json` contains a version that has never been released.
2. In GitHub Actions, run `Release macOS arm64` against `main`.
3. Confirm every workflow step passes and a draft release named `v<version>` exists.
4. Confirm the draft records the intended commit SHA and contains exactly the DMG and its `.sha256` file.

## Acceptance on another Apple Silicon Mac

Download both draft assets through the GitHub UI. This download path applies the real browser quarantine metadata that CI intentionally does not simulate.

1. From the download directory, run `shasum -a 256 -c Maka-<version>-mac-arm64.dmg.sha256`.
2. Open the DMG in Finder, drag Maka to Applications, and launch it from Finder.
3. Confirm macOS opens Maka without an unidentified-developer or damaged-app warning.
4. Run `spctl --assess --type execute --verbose=4 /Applications/Maka.app` and confirm it is accepted with a Developer ID origin.
5. Configure a model connection, send one basic prompt, and run one representative file-tool task.
6. Install `ripgrep` with `brew install ripgrep`, then confirm a task using `Grep` works.
7. Run one representative Office task and confirm OfficeCLI starts without an update prompt.
8. Confirm the known limitation is accurate: Computer Use is not included.

Publish the draft only after all checks pass. If acceptance fails, keep the draft unpublished, fix the issue, increment the desktop version, and run the workflow again; do not replace an existing release identity.
