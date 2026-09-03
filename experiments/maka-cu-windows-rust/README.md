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

# Rust/direct-COM Windows executor

This started as the comparison prototype for `apache/maka#4318` and is now the
source baseline for the native executor being moved to
`maka-cu/apps/OpenComputerUseWindows/native`. It speaks the shared `maka.cu/2`
line-delimited JSON-RPC protocol; it does not define a private Windows wire
schema.

The Windows build uses the `windows` crate only as a typed ABI declaration: UI
observation and actions call `IUIAutomation`/`IUIAutomation*Pattern` COM
interfaces directly. It supports:

* `host.hello`, session ownership, and explicit top-level window enumeration;
* bounded UIA observation with HWND/PID/generation identity;
* one-use opaque snapshot/element tokens;
* `ValuePattern.SetValue` and `InvokePattern.Invoke` semantic actions;
* focus-bound `dispatch.key` for the closed `maka.cu/2` key vocabulary and
  modifiers. It revalidates the quoted HWND/PID/process-start time/window
  generation and UIA focus before `SendInput`; delivery without an
  application-level readback remains `unknown`;
* target-window and whole-display `screen.capture` backed by
  `IGraphicsCaptureItemInterop::CreateForWindow(HWND)` and D3D11 staging
  readback (bounded PNG/base64; no GDI, screen-rectangle, or covering-pixel
  fallback); and
* EOF/shutdown boundaries with no global-pointer, coordinate, PostMessage, or
  screen fallback path.

The observation response includes both the compact `elements` list and the
driver-compatible `tree.nodes` view. Each live element carries the UIA
`RuntimeId`; action revalidation refuses to rematch a replacement by title,
index, or automation id. The target identity also records the owning PID,
process creation FILETIME, HWND, and UIA root RuntimeId fingerprint.

Capture is implemented only on Windows: the endpoint creates a WGC item from
the supplied HWND, captures a frame, copies it through a CPU-readable D3D11
staging texture, and returns a bounded PNG/base64 payload. It is tied to the
same `windowGeneration` checked by `observe`; a lost/changed target returns the
typed `capture_unavailable` result. On non-Windows or when WGC is unavailable,
the result is explicitly unavailable rather than a screen fallback.

## Build and protocol smoke

Directional `scroll` uses one ScrollPattern call followed by bounded,
same-identity Current percent reads in `src/scroll_readback.rs`. Its JSON cases
and real delayed WPF provider harness are shared with C#. The shared contract
explicitly removes ScrollItem.ScrollIntoView as a
directional-scroll fallback, refuses no-op/boundary requests before mutation,
and preserves unknown for inconclusive post-dispatch evidence. See
`../maka-cu-windows/PROTOCOL_CONTRACT.md`.

Use Cargo from `PATH` (or prepend any installed Rust toolchain directory):

```powershell
cargo test --all-targets --manifest-path experiments/maka-cu-windows-rust/Cargo.toml
cargo build --release --manifest-path experiments/maka-cu-windows-rust/Cargo.toml
```

On an interactive Windows desktop, `maka-cu2-lifecycle-driver.mjs` starts only
the deterministic WinForms fixture and exercises the shared protocol, fresh
HWND/PID/start-time/generation checks, one-use snapshots, host-owned images,
display capture, supervisor-PID death, and `apps.launch` is separately checked
by `maka-cu2-launch-driver.mjs` against the WPF fixture. The
`maka-cu2-wpf-driver.mjs` then verifies semantic set-value, button click,
selection, toggle, and scroll against the WPF page oracle. The
`maka-cu2-browser-driver.mjs` verifies semantic Chromium input/click/scroll
using a fresh temporary Chrome profile and an independent loopback oracle. The C# scripts under
`experiments/maka-cu-windows` remain historical comparison evidence until they
are migrated to the same protocol. Enter is now dispatched through the
focus-bound native path, but remains `unknown` when the helper cannot prove
the application-level effect; a page oracle event never upgrades that result.
The formal native release binary was also run directly from the `maka-cu`
checkout: the lifecycle driver passed 29/29; the WPF driver reported 17 pass,
0 fail, 0 blocked, and 1 honest Enter unknown; and the Chromium driver reported
9 pass, 0 fail, 3 blocked, and 1 honest Enter unknown. The key-dispatch reruns
use the protocol-correct `Return` wire key and preserve the same honest
classification. Six independent WPF and six independent Chromium temporary-profile runs remain consistent with those
classifications. The WPF driver was also run against the .NET 10
`net10.0-windows10.0.22621.0` fixture and reported the same 17 pass, 0 fail,
0 blocked, and 1 honest Enter unknown result. The Desktop host integration suite, using the prepared Rust
helper and the WinForms fixture, passed 117/117. Chromium click and scroll pass,
while the current Chrome UIA provider does not expose a safe writable
ValuePattern or TextPattern selection route, so input and selection are
recorded as blocked.

The measurement-only `maka-cu2-performance-driver.mjs` recorded three cold
helper handshakes at 46.916 ms, 52.471 ms, and 42.470 ms; helper working sets
were 8,601,600, 8,597,504, and 8,572,928 bytes. The first WPF frame took
1,563.699 ms from the observe request to a verified host-owned image read, and
the helper working set after that frame was 54,112,256 bytes. The raw record is
`experiments/maka-cu-windows/performance-results-cross-machine-rust-formal-native.json`.

An isolated real-app probe also started LibreOffice Writer from
`D:\\soft\\program\\soffice.exe` with a temporary user profile. It found a fresh
PID/HWND, observed 113 bounded UIA elements, and captured a host-owned WGC
frame. A single semantic Properties-button press was refused as
`dispatch_refused`; the mutation was not retried, and no user document was
opened.

The legacy `comparison-harness.mjs` still drives its Rust subject with the
former private `initialize`/`list_windows` protocol, so it reports 0/34 Rust
lifecycle checks even though the shared-protocol `maka-cu2-lifecycle-driver`
passes 29/29. That legacy result is retained as evidence of harness
incompatibility, not treated as a production Rust regression.

The full source build passes with the bundled Node.js 24.19 runtime. The
Windows x64 Electron installer build is currently environment-blocked by
Visual Studio 2022 `MSB8040` because the Spectre-mitigated C++ libraries are
not installed. The real Electron fixture smoke reaches the rendered Maka UI
and passes 7/7 programmatic checks, including the Windows non-client
frame-size adjustment. Windows Sandbox and
Hyper-V are unavailable on this machine, so clean-machine evidence and
packaged real-Maka conversation acceptance remain open. `distributionReady`
stays false.

On the development desktop this build was exercised against the existing
WinForms fixture (HWND selected from `list_windows`): `observe` found the
`fixture-input` ValuePattern, `act` returned
`verified/value_readback_match` for `set_value`, and `capture` returned an
occlusion-safe WGC PNG. The helper also accepts cancellation while a worker
request is running; the original request always settles. The host supervisor
still owns the 2-second grace expiry and force-kill of a provider-blocked
helper, as required by #4318.

## Safety and lifecycle boundary

The helper never selects a window by title or foreground state for an action;
the host must provide the HWND. Keyboard `focusPolicy=acquire` may bring that
explicitly supplied HWND to the foreground only after the quoted identity is
revalidated; `focusPolicy=require` never takes focus. An observe creates a registry entry, and
`dispatch.element` removes that entry before revalidating the target and
dispatching the COM pattern. A repeated token therefore fails closed as
`snapshot_unknown`, while a recreated/changed target fails as `window_gone`,
`process_replaced`, or `element_changed`.
Mutation results are verified by the platform operation's readback category;
the prototype does not retry unknown mutations. Stdio/control runs on its own
thread while a dedicated worker owns the MTA UIA apartment. Cancellation before
dispatch spends an `act` snapshot without touching COM; cancellation after
dispatch reports cancellation intent while allowing the original operation to
settle. A blocked COM provider still requires the host supervisor to kill the
helper after the 2-second grace period; EOF and shutdown are bounded and do not
wait for that worker.
