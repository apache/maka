<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Product release checklist

The `Release` workflow is Maka's convenience-artifact release entry point. Desktop and CLI/TUI are
built from the exact IPMC-approved ASF source candidate commit. They share that source commit, the
root product version, one convenience tag, one GitHub Release, one Draft decision, and one release
gate. The workflow creates no Draft until every required artifact job succeeds.

Phase 1 requires:

- signed and notarized Apple Silicon macOS Desktop artifacts;
- the unsigned Windows x64 Desktop installer and ZIP;
- the signed, notarized, relocatable Apple Silicon CLI/TUI ZIP;
- checksums generated after each artifact reaches its final form.

The ASF Desktop artifacts must not contain a Git runtime, a bundled-Git manifest, or Git/Dugite
redistribution notices. Managed-workspace execution remains unavailable until a separately reviewed,
ASF-compatible verified runtime is connected before admission/T1.

The first product release also requires the exact `maka-agent@<version>` npm package. The product
tag and Draft must exist before npm staging, but the Draft must remain unpublished until npm is
public, Finalize has verified it, and Desktop acceptance has exercised remote Runtime Host setup.

## One-time repository setup

Create a protected GitHub Environment named `release`, require the appropriate reviewers, and
configure:

- `CSC_LINK`: base64-encoded Developer ID Application `.p12`;
- `CSC_KEY_PASSWORD`: password for that `.p12`;
- `APPLE_API_KEY`: raw contents of an App Store Connect API `.p8` key;
- `APPLE_API_KEY_ID`: App Store Connect API key ID;
- `APPLE_API_ISSUER`: App Store Connect API issuer ID.

The checked-in release configuration pins Maka's Apple Team ID to `FABM2QUA8Q`. Confirm every
replacement `CSC_LINK` belongs to that team before changing credentials; changing the pinned Team
ID requires its own reviewed product-release change.

Windows remains unsigned until an Authenticode policy and certificate are added. Release secrets
must never be exposed to fork or ordinary pull-request jobs.

Before the first product release, confirm the checked-in `.asf.yaml` has reconciled the live repository:

- the `Immutable release tags` ruleset blocks updates, force-pushes, and deletions of `v*` tags;
- the `release` and `npm-release` Environments accept only their declared tag patterns and require a reviewer other than the triggering user;
- enable immutable releases so assets and the associated tag cannot change after publication.

These controls close the check-to-upload and check-to-stage windows. Keep the Release in Draft while assets and acceptance are incomplete; publishing early must make subsequent mutation fail closed.

## Create the complete Draft

1. Confirm the podling and Incubator PMC votes have both passed for one immutable source candidate.
   Record both result URLs and independently verify its signed annotated
   `v<version>-incubating-rc<rc>` tag.
2. Confirm that tag resolves to a commit on `main`, required CI is green for that exact commit, and
   root `package.json` contains a product version that has never been released.
3. Confirm `apps/desktop/package.json` and `packages/cli/package.json` exactly match the root
   version, and the CLI manifest exposes only the `maka` command.
4. Dispatch `Release` from the exact approved candidate tag and supply the same tag as
   `source_reference_tag`. A rerun must use that same tag; never select current `main` instead.
5. Confirm `release-identity`, both Desktop matrix entries, `cli-macos-arm64`, and
   `publish` pass. A skipped or failed required job must prevent Draft creation.
6. Confirm one Draft named `v<version>` targets the approved source SHA, identifies the ASF source
   reference in its notes, is marked as a GitHub prerelease exactly when the product version is a
   prerelease, is not marked Latest while it remains a Draft, and contains exactly the manifest
   reported by `node scripts/product-release-artifacts.mjs list`. The manifest covers both Desktop
   platforms and update metadata, the standalone CLI/TUI, and their required checksums.
7. Inspect the CLI ZIP. It must contain `bin/maka`, `RELEASE.json`, `DISCLAIMER-WIP`, `LICENSE`, `NOTICE`,
   `THIRD_PARTY_NOTICES.txt`, the pinned Node license, and no `bin/maka-agent`.
8. Confirm `RELEASE.json` records the Draft's product version and source SHA, Apple Team ID
   `FABM2QUA8Q`, the official Node
   URL/archive/digest, npm version, workspace and production dependency closures, dependency
   patches, Mach-O inventory, and `developer-id-notarized` signing state. Its final Node
   entitlements must retain the required hardened-runtime capabilities and omit
   `com.apple.security.get-task-allow`, as required by Apple's
   [notarization guidance](https://developer.apple.com/documentation/security/resolving-common-notarization-issues).
9. Inspect both Desktop resource trees and confirm `git/`, `bundled-git.json`, `licenses/git/`, and
   `licenses/dugite/` are absent.

If the publish job created the product tag or Draft but failed before every asset was uploaded,
rerun `Release` from the same approved ASF source candidate tag with the same
`source_reference_tag` input. Existing Draft assets must exactly
match the newly verified bytes; the retry keeps matching assets and uploads only missing ones. If an
asset conflicts or is unexpected, inspect and remove it manually while the Release is still a Draft,
then rerun. If only the tag exists, the retry creates the missing Draft.

## Publish and verify the npm channel

Follow [the npm release runbook](../docs/cli-npm-release.md) against the exact product tag and Draft:

1. Run **Stage CLI npm release** from `v<version>` and record its successful run ID and attempt.
2. Inspect the staged tarball and provenance, then approve that exact stage with npm 2FA.
3. Run **Finalize CLI npm channel** from `main` and confirm it verifies the public package bytes,
   provenance, signature, and release dist-tag.
4. Install the exact public version on each release platform and complete the npm acceptance steps.

Keep the GitHub Release in Draft throughout this sequence. A failed or rejected npm candidate
requires a new product version; never publish the Draft to work around npm state.

When every npm and cross-machine acceptance check has passed, publish the Draft. Mark a stable
release as Latest at that final publication boundary; prereleases must remain non-Latest.

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
9. Add a clean remote Runtime Host from the packaged Desktop app. Confirm setup installs the exact
   public `maka-agent@<version>` package and the remote session completes one model turn.

## Acceptance on a Windows x64 machine

Download the installer, Windows Desktop ZIP, and both checksum files through a browser from the same Draft.

1. Verify both SHA-256 checksums in PowerShell.
2. Expand the ZIP and launch its Maka executable once to confirm the portable artifact starts.
3. Run the installer and confirm the expected unsigned-publisher SmartScreen flow.
4. Launch Maka from the Start menu, configure a model connection, send one prompt, and run one representative file-tool task.
5. Run one terminal task and confirm packaged `node-pty` behavior.
6. Confirm the documented Computer Use limitation remains accurate.
7. Add a clean remote Runtime Host from the packaged Desktop app. Confirm setup installs the exact
   public `maka-agent@<version>` package and the remote session completes one model turn.

Immediately before publication, reverify that the approved ASF candidate tag and convenience
`v<version>` tag still resolve to the same recorded commit. Publish only after npm Finalize and both
independent-machine acceptance passes. If any required artifact, npm step, or
acceptance step fails, keep the Draft unpublished, fix the issue, increment the root product
version, and run the full workflow again. Never replace an existing release identity.
