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

# Runtime sandbox boundary

This directory owns platform sandbox selection and command transformation. It translates the profile in an active session `ExecutionBoundary` into an execution request; it does not decide whether a requested boundary expansion is approved and does not execute the request itself.

Code and focused tests are the final authority. Windows enforcement work is tracked in
[issue #2142](https://github.com/maka-agent/maka-agent/issues/2142) and specified by the
[Windows sandbox backend RFC](../../../../docs/architecture/windows-sandbox-rfc-v1.md)
([中文](../../../../docs/architecture/windows-sandbox-rfc-v1.zh-CN.md)).

## Ownership

`@maka/core` owns the platform-neutral boundary language:

- `execution-boundary.ts` defines the session boundary, its revision, and monotonic expansion.
- `permission-profile.ts` defines managed, disabled, and external profiles; file-system entries; network policy; standard profiles; and pure path matchers.
- `permission-profile-compiler.ts` preserves compatibility when a legacy product mode must be mapped to a profile.

`@maka/runtime` owns platform transformation:

- `types.ts` defines sandbox selection, command, path-context, execution-request, and typed failure contracts.
- `sandbox-manager.ts` decides whether a profile requires a sandbox, selects a platform backend, and delegates transformation.
- `macos-seatbelt.ts` builds the Seatbelt policy and wraps inner argv with `/usr/bin/sandbox-exec`.
- `linux-sandbox.ts` builds the bubblewrap mounts, namespace arguments, and network seccomp filter.
- `linux-capability.ts` proves bubblewrap and namespace availability before selection is usable.
- `windows-profile.ts` compiles managed profiles into canonical ACL, network, and environment policy.
- `windows-sandbox.ts` writes one-shot manifests and invokes the packaged AppContainer broker.
- `default-sandbox-manager.ts` registers the supported default backends.
- `index.ts` is the public subpath surface; the runtime package barrel re-exports the supported API.

## Current behavior

- Restricted managed profiles require a platform sandbox under the default `auto` preference.
- Unrestricted, disabled, and external profiles do not add a Maka-managed local sandbox.
- `require` forces platform sandbox selection; `forbid` selects host execution and is an internal orchestration input, not proof of approval.
- macOS selects the Seatbelt backend and fails closed when the backend is unavailable.
- Linux selects the bubblewrap backend and fails closed when its executable, namespace probe, or
  requested profile cannot be enforced.
- Windows selects the AppContainer broker only when its packaged native resource exists; otherwise it
  fails closed as unavailable. Other unsupported platforms return `unsupported_platform`.
- A backend that receives an invalid or unsupported profile returns a typed failure; it does not silently downgrade to host execution.

## Boundaries

- The session `ExecutionBoundary` is the authority for whether an operation is currently inside the sandbox boundary. Sandbox selection does not expand that boundary.
- The sandbox-boundary interaction path owns user approval and atomically settles an approved expansion with its new revision.
- Callers own canonical cwd and path-context construction. Platform backends must not guess workspace roots.
- `SandboxManager` transforms commands but does not spawn processes, retry without a sandbox, emit UI, or own telemetry.
- The macOS backend owns SBPL generation, root parameterization, protected-metadata deny-write rules, and network policy translation.
- `PermissionProfile.External` means file-system isolation is supplied by the environment; Maka does not stack a local platform sandbox in the current implementation.

## Non-goals

- Worktree or workspace-copy sandboxing
- Diff/write-back or apply-patch UI
- Automatic unsandboxed retry
- Managed network proxy or domain allowlists
- Windows release signing and the full Phase 4 adversarial support declaration
- A second permission language, shell runner, or file-policy system

## Verification

- Core profile factories, compiler, and matchers: `packages/core/src/__tests__/permission-profile*.test.ts`
- Selection and transformation: `packages/runtime/src/__tests__/sandbox-manager.test.ts`
- macOS policy and wrapper: `packages/runtime/src/__tests__/macos-seatbelt.test.ts`
- macOS platform behavior: `packages/runtime/src/__tests__/macos-seatbelt-smoke.test.ts`
- Linux policy and wrapper: `packages/runtime/src/__tests__/linux-sandbox.test.ts`
- Linux platform behavior: `packages/runtime/src/__tests__/linux-sandbox-smoke.test.ts`
- Windows profile and broker transform: `windows-profile.test.ts` and `windows-sandbox.test.ts`
- Public exports and default registration: `sandbox-export.test.ts` and `default-sandbox-manager.test.ts`
