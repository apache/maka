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

# Desktop Nightly

Desktop Nightly is an ephemeral developer snapshot, not an Apache release. It builds the current `main` commit every day so contributors can try recent Desktop changes and report problems without waiting for an ASF source-release vote.

The npm publication workflow gives each snapshot an immutable version such as `0.2.0-dev.42.20260829`. The run number is the sole ordering authority. After that exact npm version is public, it triggers Desktop Nightly with a version-only artifact; the authenticated workflow event supplies the exact source commit and upstream run. Each fresh Desktop Nightly creates a `v<version>` tag protected by the checked-in `Immutable release tags` ruleset and one GitHub draft prerelease containing the macOS, Windows, and Linux packages, blockmaps, `dev-mac.yml`, `dev.yml`, `dev-linux.yml`, `dev-linux-arm64.yml`, and one offline Sigstore bundle. macOS builds one architecture per runner and both write the same feed name, so each upload carries `dev-mac-<arch>.yml` and publication merges them into the single `dev-mac.yml` clients read. The workflow verifies every remote asset before it publishes the prerelease as non-Latest. Packaged Nightlies use the GitHub `dev` channel and verify that downloaded bytes were attested by `.github/workflows/desktop-nightly.yml` on `main`. A formal Desktop build uses the separate stable GitHub Release channel and formal product-release attestation identity.

Nightly currently uses the same application identity as the formal Desktop. Installing it replaces the existing Maka installation rather than creating a second side-by-side app. Its user data remains in the same location. Testers who need the formal build should reinstall that build before returning to the formal channel. Builds previously downloaded from `nightlies.apache.org` do not migrate automatically; testers must install the newest GitHub prerelease once, after which GitHub Nightlies update automatically.

## One-time setup

1. After the checked-in `.asf.yaml` reaches `main`, verify that ASF reconciliation created the `nightly` GitHub Environment with only `main` permitted and no approval gate. Do not maintain that policy manually in GitHub. Configure its macOS signing and notarization secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Do not expose these secrets to repository-wide or pull-request workflows.
2. Configure npm Trusted Publishing for `apache/maka` and `.github/workflows/npm-publication.yml`, restricted to the `npm-publication` Environment and with both `npm publish` and `npm stage publish` allowed. Do not create or store a long-lived npm token.
3. After npm Trusted Publishing is ready, set `NPM_NIGHTLY_ENABLED` to `true`, run `npm publication` from `main` with `channel=nightly`, and verify the exact npm version and `nightly` dist-tag.
4. Set `DESKTOP_NIGHTLY_ENABLED` to `true` and manually dispatch a fresh npm Nightly. Confirm that its successful run triggers `Desktop Nightly`. Do not rerun a failed attempt in place.
5. Verify that `v<version>` points to the exact source SHA and that its GitHub Release is published with Draft off, Prerelease on, Latest off, and exactly the expected assets, which `desktopNightlyReleaseAssetNames` defines. Install that prerelease on every packaged target.
6. Publish one later fresh Nightly and confirm a GitHub-to-GitHub automatic and differential update on every packaged target before sharing the channel with testers. Linux AppImage installs update in place; Linux deb installs ask for the privilege `dpkg` needs.

The npm schedule starts at 18:17 UTC. Before changing the npm tag, the workflow requires its run number to exceed the current `nightly` version. Desktop assembles and verifies a draft before one publish mutation; a packaging, attestation, tag, upload, or digest failure leaves no partially published GitHub Release. Never rerun a failed workflow attempt in place; dispatch a fresh npm Nightly with a newer version.

GitHub Release retention is intentionally outside this workflow. Do not delete an old Nightly prerelease or its tag while any installed client may need its payload or blockmap. One Nightly is additionally pinned by tag, asset name, and SHA-256 in `scripts/windows-upgrade-baseline.json` as the Windows upgrade gate's baseline: deleting that prerelease fails the gate on every pull request that touches the Windows release path until the pin moves to another published build. Disabling `DESKTOP_NIGHTLY_ENABLED` stops new Desktop publication without mutating tags or releases.

Remote Runtime Host setup uses the exact `maka-agent@<nightly-version>` package embedded in the Desktop manifest. The npm package is verified before Desktop artifacts become visible, so clean remote setup never depends on an unpublished Runtime Host version.
