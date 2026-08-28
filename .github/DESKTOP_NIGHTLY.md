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

The workflow gives each snapshot an immutable version such as `0.2.0-dev.20260829.42` and records its exact source commit in `nightly.json`. A packaged Nightly accepts updates only from `https://nightlies.apache.org/maka/desktop/`, accepts only newer `dev` versions, and verifies that downloaded bytes were attested by `.github/workflows/desktop-nightly.yml` on `main`. A formal Desktop build continues to use the GitHub Release feed and the formal product-release attestation identity.

Nightly currently uses the same application identity as the formal Desktop. Installing it replaces the existing Maka installation rather than creating a second side-by-side app. Its user data remains in the same location. Testers who need the formal build should reinstall that build before returning to the formal channel.

## One-time setup

1. Ask Apache Infra to allow `apache/maka` to publish GitHub Actions output to `nightlies.apache.org`. The resulting repository secrets are `NIGHTLIES_RSYNC_PATH`, `NIGHTLIES_RSYNC_HOST`, `NIGHTLIES_RSYNC_PORT`, `NIGHTLIES_RSYNC_USER`, and `NIGHTLIES_RSYNC_KEY`.
2. Create a GitHub Environment named `nightly` that permits only `main`. Configure its macOS signing and notarization secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Do not expose these secrets to pull-request workflows.
3. Merge the Nightly workflow while it is disabled. After Infra publishing and the Environment secrets are ready, set the repository variable `DESKTOP_NIGHTLY_ENABLED` to `true` and run `Desktop Nightly` manually once.
4. Verify the download page, `nightly.json`, `latest-mac.yml`, and `latest.yml` under `https://nightlies.apache.org/maka/desktop/`, install both platform artifacts on clean machines, and confirm one automatic update before sharing the channel with testers.

The scheduled run starts at 18:17 UTC. It audits the shipped dependency closure, builds and verifies macOS arm64 and Windows x64 artifacts, issues and locally verifies Sigstore provenance, replaces the previous versioned payloads, and advances the mutable update metadata last. A failed build leaves the previous Nightly feed untouched. Apache Nightlies storage is temporary; it must not be used as a formal release archive.

Remote Runtime Host setup still follows the package identity embedded in the repository manifests. A Nightly does not publish a matching npm package, so clean remote setup is outside this channel until that dependency has its own reviewed snapshot distribution contract.
