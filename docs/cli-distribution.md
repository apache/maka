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

# CLI/TUI distribution contract

Maka ships its CLI/TUI as a required artifact of the same product release as Desktop. Phase 1
publishes one signed and notarized Apple Silicon artifact:

`Maka-<version>-cli-mac-arm64.zip`

The ZIP contains an exactly pinned official Node runtime and the production workspace/npm
dependency closure derived from repository manifests and `package-lock.json`. It does not use a
system Node installation or a single-file/SEA build.

## Public contract

Only these surfaces are stable:

- `bin/maka`, including invocation through a symlink outside the extracted archive;
- the documented `RELEASE.json` fields below.

`libexec/**` is private and may change between releases. There is no public `maka-agent` launcher.
The TUI is the default interactive mode of `maka`, not a separate artifact.

`RELEASE.json` fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Metadata schema version, initially `1` |
| `product` | Product name, `Maka` |
| `version` | Root `package.json` product version |
| `sourceCommit` | Exact source commit shared by every release artifact |
| `platform` / `architecture` | Artifact target, `macos` / `arm64` |
| `publicCommands` | Public command list; exactly `["maka"]` in Phase 1 |
| `node` | Official Node version, source URL, archive name, and archive SHA-256 |
| `npmVersion` | Exact npm version used to materialize the production closure |
| `dependencyPatches` | Sorted repository patches applied to the staged dependencies |
| `productionDependencies` | Sorted external `name@version` production closure |
| `thirdPartyNoticesSha256` | Digest binding notices to this artifact |
| `workspacePackages` | Sorted manifest-derived production workspace closure |
| `machOBinaries` | Sorted paths of every Mach-O file that must be signed and verified |
| `signing` | `developer-id-notarized` for release artifacts; `development` for local checks |

The CLI-specific `THIRD_PARTY_NOTICES.txt` must enumerate exactly the external production
dependencies recorded in `RELEASE.json`. The archive also carries the repository's
`DISCLAIMER-WIP`, `LICENSE`, `NOTICE`, and the pinned Node runtime license. The archive checksum is
generated only after signing and notarization complete.

Every Mach-O file inside the archive is signed and the ZIP is submitted to Apple's notary service.
ZIP files cannot carry a stapled notarization ticket, so the first Gatekeeper assessment on another
Mac may require network access to retrieve the ticket from Apple. The embedded code signatures and
published SHA-256 remain available for offline verification; do not describe the ZIP itself as
stapled.

## Release and installation boundary

Root `package.json` is the sole version authority. Desktop and CLI manifests must match before
packaging. Desktop, CLI/TUI, and source jobs build independently from one commit; one publish job
collects their verified outputs and creates one Draft GitHub Release.

The GitHub Release ZIP is the immutable standalone distribution source. npm keeps its
installer-specific tarball, OIDC, staged-publishing, and 2FA approval flow, but may start only after
the product `v<version>` tag and GitHub Release exist. It checks out that tag's exact commit and
derives the same version, runtime closure, file policy, notices, and source identity. It does not
create a tag or GitHub Release and does not block creation of the product Draft. Homebrew must
consume the standalone ZIP.

## Decision ledger

| Question | Decision | Enforced by |
| --- | --- | --- |
| Which file owns the product version? | Root `package.json`; Desktop and CLI manifests must match it. | `product-release-identity.mjs` and release contract tests |
| Which event defines a product release? | One `v<version>` tag from `main`, one source commit, and one Draft GitHub Release. An interrupted Draft upload may retry only that exact commit. | `release.yml` identity and publish jobs plus the exact-tag helper |
| Which artifacts are required? | macOS and Windows Desktop installers and update assets, the macOS arm64 standalone CLI ZIP, and bundled source. | The exact manifest from `product-release-identity.mjs`, enforced by each artifact job and the publish job |
| Is npm another release authority? | No. It is an optional install channel whose Stage ref, source, workflow identity, and provenance all resolve to the existing product tag commit. | Tag-dispatched OIDC staging and read-only finalization; no npm-specific tag or GitHub Release |
| Does the standalone CLI define another package policy? | No. It derives the workspace closure, third-party pruning, notices, and Eval runtime assets from their current manifests and shared policy. | Packaging and artifact contract tests |
| Which commands are public? | `maka` only; TUI is its default mode. | CLI manifest, help tests, wrapper, and release metadata |
