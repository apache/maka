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
[issue #2142](https://github.com/apache/maka/issues/2142) and specified by the
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

## Product coverage

| Surface                                                                             | macOS                                                     | Linux                                                     | Windows                                                                                                     | When no Maka-managed sandbox is required                                                                                          |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Agent Bash, foreground or background without a PTY                                  | Seatbelt                                                  | bubblewrap                                                | Restricted managed execution fails closed because the AppContainer broker cannot launch an arbitrary shell  | Runs through the detected host shell                                                                                              |
| Agent Bash with a PTY                                                               | Refused when the active profile requires sandboxing       | Refused when the active profile requires sandboxing       | Refused when the active profile requires sandboxing                                                         | Runs as a host PTY                                                                                                                |
| Local-path `Read`, `Write`, `Edit`, `FormatJson`, `Glob`, `Grep`, and `apply_patch` | Filesystem worker under Seatbelt                          | Filesystem worker under bubblewrap                        | Purpose-built filesystem worker under the AppContainer broker, subject to the fail-closed limitations below | Managed execution uses the worker without an OS sandbox; bypass uses the host-local executor; external uses the injected executor |
| `Read` of runtime or attachment resource refs                                       | Resource service; not a local filesystem-worker operation | Resource service; not a local filesystem-worker operation | Resource service; not a local filesystem-worker operation                                                   | Same resource-service path                                                                                                        |
| Client `runtime.resource.start` integrated terminal                                 | Host PTY outside the managed agent boundary               | Host PTY outside the managed agent boundary               | Host PTY outside the managed agent boundary                                                                 | Same host PTY path                                                                                                                |

In the Windows AppContainer preview, local-path `Read`, `Glob`, existing-target `Write`, `Edit`, `FormatJson`, and `apply_patch` update operations run through the filesystem worker. `Grep` fails closed with `grep_unavailable`. Missing-target `Write` and `apply_patch` create/delete operations also fail closed because the current broker policy cannot represent exact parent-entry write authority without widening the kernel grant.

`ask` starts with the managed `workspace-write` profile and `explore` starts with a managed read-only profile. Both profiles require a platform sandbox because their filesystem or network policy is restricted. `workspace-write` permits writes to the workspace roots, `:tmpdir`, and `:slash_tmp`; it is not a workspace-only profile.

A bypass boundary, unrestricted managed profiles, and disabled profiles do not request a Maka-managed local sandbox. When the filesystem worker is wired, managed execution can still use that worker as its backend while `SandboxManager` selects `none`; this is process separation, not OS sandbox enforcement. A bypass boundary uses the host-local executor, while an external boundary delegates filesystem isolation to its injected workspace executor and does not stack a local platform sandbox. Tool availability and permission policy still apply when sandboxing is not required; selecting `none` is not itself permission to execute.

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
- macOS filesystem-worker behavior: `packages/runtime/src/__tests__/filesystem-worker-smoke.test.ts`
- Linux policy and wrapper: `packages/runtime/src/__tests__/linux-sandbox.test.ts`
- Linux platform behavior: `packages/runtime/src/__tests__/linux-sandbox-smoke.test.ts`
- Linux filesystem-worker behavior: `packages/runtime/src/__tests__/filesystem-worker-linux-smoke.test.ts`
- Windows profile and broker transform: `windows-profile.test.ts` and `windows-sandbox.test.ts`
- Windows filesystem-worker behavior: `packages/runtime/src/__tests__/filesystem-worker-windows-smoke.test.ts`
- Runtime Host product composition: `packages/runtime-host/src/__tests__/execution-model-composition.test.ts`
- Public exports and default registration: `sandbox-export.test.ts` and `default-sandbox-manager.test.ts`
