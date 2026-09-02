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

# Minimal Rust/direct-COM Windows executor

This is a comparison prototype for `apache/maka#4318`, not a product backend.
It deliberately keeps the private `maka.cu.windows/0` line-delimited JSON-RPC
shape used by the C# feasibility helper so the two implementations can be run
by the same driver.

The Windows build uses the `windows` crate only as a typed ABI declaration: UI
observation and actions call `IUIAutomation`/`IUIAutomation*Pattern` COM
interfaces directly. It supports:

* handshake (`initialize`) and explicit top-level window enumeration;
* bounded UIA observation with HWND/PID/generation identity;
* one-use opaque snapshot/element tokens;
* `ValuePattern.SetValue` and `InvokePattern.Invoke` semantic actions;
* a target-window `capture` endpoint backed by
  `IGraphicsCaptureItemInterop::CreateForWindow(HWND)` and D3D11 staging
  readback (bounded PNG/base64; no GDI, screen-rectangle, or covering-pixel
  fallback); and
* EOF/shutdown boundaries with no child-side global input or fallback path.

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
and real delayed WPF provider harness are shared with C#. Private comparison
contract revision 0.1.1 explicitly removes ScrollItem.ScrollIntoView as a
directional-scroll fallback, refuses no-op/boundary requests before mutation,
and preserves unknown for inconclusive post-dispatch evidence. See
`../maka-cu-windows/PROTOCOL_CONTRACT.md`.

Use the checked-in toolchain path when it is not on `PATH`:

```powershell
$cargo = 'D:\rust\rust\.cargo\bin\bin\cargo.exe'
& $cargo test --manifest-path experiments/maka-cu-windows-rust/Cargo.toml
& $cargo build --release --manifest-path experiments/maka-cu-windows-rust/Cargo.toml
```

On an interactive Windows desktop, `rust-driver.mjs` runs the common protocol
smoke against an existing fixture HWND. The C# fixture/lifecycle scripts under
`experiments/maka-cu-windows` remain the deterministic source of truth; pass
the same fixture HWND and compare the JSON outcomes. Clean-machine and the
real-application matrix remain open evidence for the architecture decision;
`distributionReady` stays false.

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
the host must provide the HWND. An observe creates a registry entry, and `act`
removes that entry before revalidating the target and dispatching the COM
pattern. A repeated token therefore fails closed as `snapshot_spent`, while a
recreated/changed target fails as `window_changed` or `element_changed`.
Mutation results are verified by the platform operation's readback category;
the prototype does not retry unknown mutations. Stdio/control runs on its own
thread while a dedicated worker owns the MTA UIA apartment. Cancellation before
dispatch spends an `act` snapshot without touching COM; cancellation after
dispatch reports cancellation intent while allowing the original operation to
settle. A blocked COM provider still requires the host supervisor to kill the
helper after the 2-second grace period; EOF and shutdown are bounded and do not
wait for that worker.
