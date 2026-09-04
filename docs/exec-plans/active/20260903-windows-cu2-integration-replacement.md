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

# Windows `maka.cu/2` integration replacement

## Objective

Rebuild the Windows Computer Use integration on the current `apache/main`
baseline, consuming only a pinned, validated Rust helper artifact and the
existing shared `maka.cu/2` host service.

## Scope

- Add Windows platform selection to the existing protocol backend.
- Select the `windowsCu` manifest entry and verify every packaged helper file.
- Package the helper directory only when `distributionReady` is true; fail the
  build when readiness is true but the exact helper is missing.
- Keep local preparation permanently at `distributionReady: false`; a future
  release qualification verifier must establish attestation, Authenticode,
  clean-machine, and packaged-conversation evidence mechanically.
- Do not copy the old PR's generated browser JSON, raw outputs, experiments,
  duplicate service, or compatibility input subsystem.

## Evidence boundary

The companion executor fix is pinned separately in `maka-cu#8`. This worktree
does not claim clean-machine validation, packaged conversation E2E, signing,
or distribution readiness. Those fields must be supplied by a release
qualification pipeline and must match the exact binary digest.

## Progress

- [x] Start from the current `apache/main` after #4497.
- [x] Reuse the existing `MakaCuService` and `maka.cu/2` backend.
- [x] Add Windows manifest, exact digest-set validation, and readiness-gated packaging.
- [x] Make readiness fail closed instead of trusting caller-authored provenance booleans.
- [x] Require the packaged helper's exact file set/size/digests and a valid Authenticode status.
- [x] Use a locked explicit `x86_64-pc-windows-msvc` source build contract.
- [ ] Run a real packaged Windows conversation E2E on the exact artifact.

## Validation

- `npm run build --workspace @maka/computer-use` — pass with shared checkout dependencies.
- `npm run typecheck --workspace @maka/desktop` — baseline failure unrelated to
  this change; no diagnostic references the changed host or selector files.
- `node --test scripts/prepare-windows-cu-helper.test.mjs` — 4 passed.
- Focused release/verifier assertions pass; unrelated full script tests still
  require generated workspace build output and a working Bash/WSL path.
- Windows packaged/clean-machine validation — not run in this environment.
