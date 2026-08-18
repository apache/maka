# Product release checklist

The `Release` workflow is Maka's single release entry point. Desktop, CLI/TUI, and source
materials share one source commit, root product version, tag, GitHub Release, Draft decision,
and release gate. The workflow creates no Draft until every required artifact job succeeds.

Phase 1 requires:

- signed and notarized Apple Silicon macOS Desktop artifacts;
- the unsigned Windows x64 Desktop installer and ZIP;
- the signed, notarized, relocatable Apple Silicon CLI/TUI ZIP;
- bundled Git source materials;
- checksums generated after each artifact reaches its final form.

## One-time repository setup

Create a protected GitHub Environment named `release`, require the appropriate reviewers, and
configure:

- `CSC_LINK`: base64-encoded Developer ID Application `.p12`;
- `CSC_KEY_PASSWORD`: password for that `.p12`;
- `APPLE_API_KEY`: raw contents of an App Store Connect API `.p8` key;
- `APPLE_API_KEY_ID`: App Store Connect API key ID;
- `APPLE_API_ISSUER`: App Store Connect API issuer ID.

Windows remains unsigned until an Authenticode policy and certificate are added. Release secrets
must never be exposed to fork or ordinary pull-request jobs.

## Create the complete Draft

1. Confirm the intended commit is on `main`, required CI is green, and root `package.json`
   contains a product version that has never been released.
2. Confirm `apps/desktop/package.json` and `packages/cli/package.json` exactly match the root
   version, and the CLI manifest exposes only the `maka` command.
3. In GitHub Actions, run `Release` against `main`.
4. Confirm `release-identity`, both Desktop matrix entries, `cli-macos-arm64`, `source`, and
   `publish` pass. A skipped or failed required job must prevent Draft creation.
5. Confirm one Draft named `v<version>` targets the intended source SHA and contains at least:
   - `Maka-<version>-mac-arm64.dmg` and checksum;
   - `Maka-<version>-win-x64.exe` and checksum;
   - `Maka-<version>-cli-mac-arm64.zip` and checksum;
   - `Maka-<version>-bundled-git-source.tar.gz` and checksum;
   - the platform update metadata and Desktop ZIPs produced by electron-builder.
6. Inspect the CLI ZIP. It must contain `bin/maka`, `RELEASE.json`, `DISCLAIMER-WIP`, `LICENSE`, `NOTICE`,
   `THIRD_PARTY_NOTICES.txt`, the pinned Node license, and no `bin/maka-agent`.
7. Confirm `RELEASE.json` records the Draft's product version and source SHA, the official Node
   URL/archive/digest, npm version, workspace and production dependency closures, dependency
   patches, Mach-O inventory, and `developer-id-notarized` signing state.
8. Extract the bundled Git source-materials archive. Confirm `SOURCE_MANIFEST.json`, `README.txt`,
   all manifest archives, and the expected Dugite native release are present.

If the publish job created the product tag or Draft but failed before every asset was uploaded, rerun
`Release` from `main` with `source_commit` set to the exact commit already named by the tag. This
input is recovery-only: the workflow requires it to remain an ancestor of `main`, rejects a tag that
points elsewhere, refuses to replace a published Release, and replaces the Draft's asset set with the
newly verified artifacts. If only the tag exists, the retry creates the missing Draft.

## Acceptance on another Apple Silicon Mac

Download the DMG, CLI ZIP, and their checksum files through a browser from the Draft. Do not move
artifacts directly from the workflow runner; the browser path supplies the real quarantine
boundary.

1. Run `shasum -a 256 -c` for the DMG and CLI ZIP.
2. Install and launch the Desktop app from Finder. Confirm there is no unidentified-developer or
   damaged-app warning.
3. Run `spctl --assess --type execute --verbose=4 /Applications/Maka.app` and confirm a Developer
   ID origin.
4. Extract the CLI ZIP without clearing quarantine. Run `bin/maka --version` and `bin/maka --help`.
   Keep the Mac online for this first Gatekeeper assessment: the notarized ZIP cannot carry a
   stapled ticket, so macOS may retrieve it from Apple.
5. Create an external link, for example `ln -s "$PWD/bin/maka" /tmp/maka-release-acceptance`, and
   confirm the linked command reports the same version and help output.
6. Start `bin/maka` with no arguments and confirm the TUI renders, accepts input, and exits cleanly.
7. Exercise one non-interactive `bin/maka run`, one deterministic `bin/maka eval run`, and one streaming
   tool-call path against the packaged artifact.
8. Configure a Desktop model connection, send one prompt, and run one representative file-tool
   task. Confirm the documented Computer Use limitation remains accurate.

## Acceptance on a Windows x64 machine

Download the installer and checksum through a browser from the same Draft.

1. Verify the SHA-256 in PowerShell.
2. Run the installer and confirm the expected unsigned-publisher SmartScreen flow.
3. Launch Maka from the Start menu, configure a model connection, send one prompt, and run one
   representative file-tool task.
4. Run one terminal task and confirm packaged `node-pty` behavior.
5. Confirm the documented Computer Use limitation remains accurate.

Publish only after both independent-machine acceptance passes. If any required artifact or
acceptance step fails, keep the Draft unpublished, fix the issue, increment the root product
version, and run the full workflow again. Never replace an existing release identity.
