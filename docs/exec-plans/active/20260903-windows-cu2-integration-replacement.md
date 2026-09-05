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
- `npm run build:test` and `npm --workspace @maka/desktop run build:main` — pass
  in the isolated verification worktree.
- `node --test --test-name-pattern "pinned Windows helper" apps/desktop/dist/main/__tests__/computer-use-host.test.js` — 1 passed. The
  fixture keeps `bundled-tools.json` at the resources root and pins only the
  packaged helper directory; readiness, tamper, missing-file, extra-file, and
  extra-directory rejection assertions all pass.
- The complete Desktop host test on this Windows machine is 4 passed / 1
  failed: the unrelated symlink fixture is blocked by Windows `EPERM`. The
  focused Windows helper test passes; this local result does not weaken the
  runtime validation.
- `npm --workspace @maka/computer-use run test:dist` on this Windows machine
  was 47 passed / 67 failed, primarily because unchanged Unix shebang mock
  executables fail to spawn with Windows `EFTYPE`. Independent Linux CI at
  [run 33860689952](https://github.com/apache/maka/actions/runs/33860689952)
  passed 114/114 with 0 failures; its diff check against base `3f4ac8c` was
  empty for the service and both mock-test files.
- Windows packaged/clean-machine validation — not run in this environment.

## Native artifact verification (2026-09-05)

- Companion executor: `maka-agent/maka-cu` commit
  `9d9cd58405f607c6345a4f8f1c2c6c993b2a175c` (PR #8).
- `cargo +stable-x86_64-pc-windows-msvc build --locked --release --target x86_64-pc-windows-msvc --manifest-path apps/OpenComputerUseWindows/native/Cargo.toml` — passed.
- The matching `cargo test --locked --release --target x86_64-pc-windows-msvc`
  invocation with the same toolchain and manifest — 14 passed, 0 failed.
- Built executable SHA-256:
  `172c482ad8d6ca126fb65bae486b799350127e93449ee731d0541772d012cda9`.
- PE import inspection found no dynamic Visual C++ or Universal CRT runtime
  DLL dependency. Authenticode status is `NotSigned`.
- These are local source-build checks, not signed release provenance or
  clean-machine acceptance. `distributionReady` remains false.

## Live Host probe (2026-09-05)

- Used the built `createComputerUseHost` from PR head `bbed22ed4` and the
  exact native artifact above, with a separate temporary manifest and helper
  directory. No production backend or supervisor was mocked.
- Host selection, real helper startup/handshake, and observation of a
  dedicated non-activating WinForms fixture succeeded.
- Independent fixture readback showed the requested text value, a checked
  checkbox, and exactly one button invocation. All three helper results were
  nevertheless `outcome_unknown`; those results remain unknown and none of
  the mutations was retried.
- Foreground HWND/PID and pointer position differed between the initial and
  final samples; the clipboard sequence was unchanged. These samples do not
  establish whether the foreground/pointer changes came from user activity
  or the tested path. Overall background non-interference acceptance is
  **blocked**, not passed.
- The probe used `isPackaged: false` and controlled callbacks returning false
  for physical-input activity and screen lock. The production Desktop guard
  still blocks activity during recent user input. This probe does not prove
  concurrent-user typing or a packaged conversation flow.
- Session clear and backend disposal were invoked; the supervisor reported
  `disposed`. This is not a separately observed `session.end` acknowledgement.
