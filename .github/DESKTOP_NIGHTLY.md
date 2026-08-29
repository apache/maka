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

The npm publication workflow gives each snapshot an immutable version such as `0.2.0-dev.42.20260829`. The run number is the sole ordering authority. After that exact npm version is public, it triggers Desktop Nightly with a version-only artifact; the authenticated workflow event supplies the exact source commit and upstream run. A packaged Nightly accepts updates only from `https://nightlies.apache.org/maka/desktop/`, advances only to a higher run number, and verifies that downloaded bytes were attested by `.github/workflows/desktop-nightly.yml` on `main`. A formal Desktop build continues to use the GitHub Release feed and the formal product-release attestation identity.

Nightly currently uses the same application identity as the formal Desktop. Installing it replaces the existing Maka installation rather than creating a second side-by-side app. Its user data remains in the same location. Testers who need the formal build should reinstall that build before returning to the formal channel.

## One-time setup

1. Ask Apache Infra to allow `apache/maka` to publish GitHub Actions output to `nightlies.apache.org`, provide the SSH `known_hosts` entry through an authenticated channel, and confirm whether retention is service-managed or requires a separate project cleanup job. Do not enable scheduled publication until that retention owner is explicit.
2. Create a GitHub Environment named `nightly` that permits only `main`. Store `NIGHTLIES_RSYNC_PATH`, `NIGHTLIES_RSYNC_HOST`, `NIGHTLIES_RSYNC_PORT`, `NIGHTLIES_RSYNC_USER`, `NIGHTLIES_RSYNC_KEY`, and the Infra-verified `NIGHTLIES_RSYNC_KNOWN_HOSTS` value as Environment secrets. Configure its macOS signing and notarization secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Do not expose these secrets to repository-wide or pull-request workflows.
3. Configure npm Trusted Publishing for `apache/maka` and `.github/workflows/npm-publication.yml`, restricted to the `npm-publication` Environment and with both `npm publish` and `npm stage publish` allowed. Do not create or store a long-lived npm token.
4. After npm Trusted Publishing is ready, set `NPM_NIGHTLY_ENABLED` to `true`, run `npm publication` from `main` with `channel=nightly`, and verify the exact npm version and `nightly` dist-tag. This does not depend on Desktop Infra.
5. After Infra publishing and the `nightly` Environment secrets are ready, set `DESKTOP_NIGHTLY_ENABLED` to `true` and start a fresh npm Nightly. Confirm that its successful run triggers `Desktop Nightly`.
6. Verify the download page, `latest-mac.yml`, and `latest.yml` under `https://nightlies.apache.org/maka/desktop/`, install both platform artifacts on clean machines, and confirm one automatic update before sharing the channel with testers.

The npm schedule starts at 18:17 UTC. Before changing the npm tag, the workflow requires its run number to exceed the current `nightly` version. Desktop applies the same check against both remote feed files before uploading anything. It then appends a new immutable Desktop version directory and advances the mutable update metadata last. Each platform feed file is replaced independently after its complete payload exists, so an interrupted feed transfer may temporarily leave macOS and Windows on different valid Nightly versions. Do not rerun a failed workflow attempt in place; start a fresh npm Nightly so it receives a new version. Historical payload cleanup is separate from publication, targets the Nightlies retention policy, and must never rewrite a published version or delete one referenced by a feed. Apache Nightlies storage is temporary; it must not be used as a formal release archive.

Remote Runtime Host setup uses the exact `maka-agent@<nightly-version>` package embedded in the Desktop manifest. The npm package is verified before Desktop artifacts become visible, so clean remote setup never depends on an unpublished Runtime Host version.
