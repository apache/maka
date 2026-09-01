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

# `@maka/computer-use`

`@maka/computer-use` adapts Maka's Runtime-owned Computer Use contracts to the
native `maka-cu` executor. It owns backend selection, the executor process and
protocol lifecycle, host-side result decoding, display snapshot mapping, and
the cursor-overlay hook. Runtime owns the model-facing tools and session state;
Desktop supplies the executable and presentation dependencies.

## Public seam

The package exposes one root entry point through `src/index.ts`:

- `selectComputerUseBackend()` selects the available platform executor and
  builds the Runtime tool set. `maka-cu` remains the macOS backend and
  `windows-native` is selected on Windows.
- `createMakaCuBackend()` adapts the native executor to Runtime's
  `CuDispatchBackend` contract.
- `MakaCuService` supervises the executor process and owns the JSON-RPC request,
  cancellation, restart, and generation lifecycle.
- The `maka-cu-protocol` exports decode and validate `maka.cu/2` envelopes,
  snapshots, dispatch results, domain errors, and key chords.
- `resolveCuaDisplaySnapshots()` maps executor screenshots to Electron display
  coordinates without guessing when the display geometry is ambiguous.
- `createComputerUseOverlayHook()` projects action lifecycle events to a
  presentation-only cursor sink. It does not choose or authorize targets.

Other packages should import these exports from `@maka/computer-use`, not from
undeclared internal source paths.

## Current platform boundary

The shipped selector enables the platform backend only when all of these
conditions hold:

1. the host platform is macOS (`maka-cu`) or Windows (`windows-native`);
2. the composition supplies the platform helper executable path; and
3. the composition supplies the executable's expected SHA-256 digest. Packaged
   Windows builds additionally require the manifest's `distributionReady` flag.

On another platform, with missing inputs, or when backend construction fails,
selection fails closed to `backendId: 'none'` with an empty tool set. This
package does not discover, download, or choose an unpinned executable.

The executable's build, provenance, signing, and distribution status are
separate release concerns. See
[`computer-use-provenance.md`](../../docs/computer-use-provenance.md) rather
than assuming that installing this workspace supplies a runnable binary.

Cross-platform work is tracked separately:

- [#3896](https://github.com/apache/maka/issues/3896) — platform abstraction;
- [#3891](https://github.com/apache/maka/issues/3891) — Linux backend;
- [#4318](https://github.com/apache/maka/issues/4318) — Windows native Computer
  Use product integration;
- [#3785](https://github.com/apache/maka/issues/3785) — related Windows
  executor hardening and production evidence.

## Protocol and lifecycle

The host and executor communicate over line-delimited JSON-RPC using the
versioned `maka.cu/2` protocol. `MakaCuService` verifies that the executable is
usable and checks any configured digest before spawning it, completes a
`host.hello` handshake, and exposes the executor version, capabilities, limits,
and process generation. The product selector always supplies the required
digest.

Lifecycle and protocol failures remain distinct:

- `MakaCuLifecycleError` reports unavailable, mismatched, aborted, or
  outcome-unknown process states;
- `MakaCuRpcError` reports a JSON-RPC error response for one method; and
- `MakaCuProtocolViolation` reports malformed or contradictory wire data.

An executor exit releases affected sessions and invalidates their observations.
Requests that may have reached the executor surface as outcome-unknown rather
than being replayed automatically. Runtime must re-observe before another
action.

## Ownership rules

- Keep provider-neutral Computer Use types and model-facing contracts in
  `@maka/core` and `@maka/runtime`.
- Keep native executor transport, decoding, and lifecycle handling in this
  package.
- Keep Electron windows, screen-lock integration, binary provisioning, and
  product status UI in `apps/desktop`.
- Add a second backend only after it has a real adapter and platform evidence;
  do not widen `CU_BACKEND_IDS` with a placeholder.
- Preserve fail-closed selection and snapshot-bound dispatch. Missing or stale
  authority must not fall back to global pointer or foreground input.

The cross-layer safety and evidence rules live in the
[`Computer Use foundation contract`](../../docs/computer-use-foundation-contract.md)
and [`host events contract`](../../docs/computer-use-host-events-contract.md).

## Verification

Install dependencies once at the repository root, then run:

```sh
npm run build
npm --workspace @maka/computer-use run test:dist
npm --workspace @maka/computer-use run typecheck
```

The package tests cover protocol decoding, process lifecycle, backend behavior,
host-event propagation, display mapping, overlay projection, and the cumulative
Computer Use path.

# Windows native backend

On Windows the selector uses the dedicated `windows-native` backend. It
speaks `maka.cu.windows/0` to the C# helper, requires an explicit HWND, and
keeps one use observation tokens for UIA semantic mutations. The backend
supports `list_apps`, `observe`, `screenshot`, `set_value`, and
`click_element`; unsupported coordinate/global input actions return a typed
`unsupported_action` refusal. Helper restarts invalidate every session's
observation lease. The helper publish is a managed single-file payload with
Windows Desktop native companion files; the manifest pins every file's size
and SHA-256 and the Desktop host verifies the complete closure before launch.
See `docs/windows-support.md` for preparing a development artifact and the
packaged distribution gate.
