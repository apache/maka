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

# maka-cu-windows feasibility spike

This private experiment supports apache/maka#4318. It is a supervised,
fixture-only feasibility spike for a long-lived C# helper on Windows. It does
not enable a Windows product backend, change the public protocol, or perform
keyboard, pointer, coordinate, `PostMessage`, `SendInput`, foreground, or
screen-rectangle fallback actions.

The local machine has only .NET SDK 8.0.421, so the spike targets
`net8.0-windows10.0.22621.0`. .NET 8 is temporary evidence only; a production
follow-up must evaluate .NET 10 LTS and rebuild self-contained artifacts for
runtime patching. No SDK was installed globally for this spike.

## Components

- `src/Program.cs`: line-delimited JSON-RPC 2.0, an MTA UIA lane, bounded
  request/snapshot registries, strict process-start/window-generation identity,
  opaque snapshot tokens, typed readback outcomes, and cancellation settlement.
- `src/WgcCapture.cs`: target-window `CreateForWindow(HWND)` capture and a
  D3D11 staging-texture PNG encoder. Capture has no rectangle fallback and
  reports `capture_unavailable` on failure.
- `fixture/HangWindowFixture`: purpose-built WinForms fixture. `freeze` blocks
  its UI thread so UIA provider calls can hang; `recreate` replaces its HWND;
  `cover` tests target capture under occlusion.
- `driver.mjs`: safe smoke flow. It accepts only the exact fixture HWND and
  never scans or mutates user windows.
- `lifecycle-driver.mjs`: C4–C6, identity, and parent-death reproduction
  scenarios. It owns and tears down all fixture/helper processes.
- `parent-probe.mjs`: short lived host used to prove helper parent-death
  cleanup after an initialized, blocked observe.
- `protocol-regression.mjs`: malformed-method, unknown-cancel, and EOF plus
  stdout-backpressure regressions without a GUI.
- `publish.ps1`: reproducible self-contained single-file publish plus manifest
  and SHA-256 hash.

## Build and fixture run

```powershell
dotnet build experiments/maka-cu-windows/src/MakaCuWindows.csproj -c Release
dotnet build experiments/maka-cu-windows/fixture/HangWindowFixture/HangWindowFixture.csproj -c Release
node experiments/maka-cu-windows/lifecycle-driver.mjs `
  experiments/maka-cu-windows/src/bin/Release/net8.0-windows10.0.22621.0/maka-cu-windows.exe `
  experiments/maka-cu-windows/fixture/HangWindowFixture/bin/Release/net8.0-windows10.0.22621.0/maka-cu-windows-fixture.exe
node experiments/maka-cu-windows/protocol-regression.mjs `
  experiments/maka-cu-windows/out/publish/maka-cu-windows.exe
```

The lifecycle run starts only the named fixture and helper. The fixture window
is visible because UIA and WGC require an interactive desktop. Do not point
either driver at a user application.

## Published artifact

```powershell
powershell -ExecutionPolicy Bypass -File experiments/maka-cu-windows/publish.ps1
node experiments/maka-cu-windows/lifecycle-driver.mjs `
  experiments/maka-cu-windows/out/publish/maka-cu-windows.exe `
  experiments/maka-cu-windows/out/fixture/maka-cu-windows-fixture.exe
```

The intended layout is self-contained `win-x64`, single-file, trimming
disabled, unsigned, and `distributionReady: false`. The manifest records the
actual SDK, target framework, publish settings, sizes, and hashes. The
published run is the relevant packaging evidence; `dotnet run` is not.

## Current local evidence (Windows 11 Insider 10.0.26220, x64)

| Check | Result | Evidence or limit |
| --- | --- | --- |
| 1. handshake | pass | Protocol `maka.cu.windows/0`; 10 s handshake / 20 s request / 2 s cancel grace declared. |
| 2. MTA UIA observation | pass on fixture | Dedicated MTA lane, bounded shallow tree, exact PID/HWND/start time/generation. |
| 3. semantic action | pass on fixture | `ValuePattern.SetValue`, pre-dispatch snapshot spend, strict revalidation, readback; duplicate tokens refuse. |
| 4. WGC target capture | pass on fixture | `CreateForWindow(HWND)` plus D3D11 staging readback produced real PNG bytes (464x352, 9,366 bytes); decoded LimeGreen sentinel remained present under an occluding fixture cover and after uncover. No rectangle fallback. |
| 5. cancellation settlement | pass on fixture | In-flight post-dispatch cancellation settles the original request with `verified`; queued cancellation settles `refused/cancelled_before_dispatch` and readback proves no mutation. |
| 6. hung-provider recovery | pass on fixture/helper | Frozen fixture remains alive; supervisor kills helper after 2 s, confirms exit, restarts with a new generation, and old snapshots are unknown. |
| identity cases | partial | Whole-window recreation returns a new HWND and rejects the old snapshot; same-window control replacement was not exercised. New explicit selection is required. |
| parent death | pass on fixture/helper | Dedicated parent probe completed initialize and a blocked observe, exited host code 77, and the helper disappeared without the lifecycle driver killing that helper PID. EOF and fail-closed stdout backpressure also exited within the deadline. A production integration should still add independent OS-level supervision. |

These are development-machine results, not clean-machine or supported-release
certification. A clean machine with no .NET runtime/SDK and an interactive
desktop has not been run here, so the spike is not a production go decision.

## D1–D6 decision record

- **D1 UIA binding:** retain managed `System.Windows.Automation` for the spike;
  the dedicated MTA lane and targeted `FindFirst` avoid unbounded Chromium
  subtree enumeration. A blocked provider still needs helper restart.
- **D2 frame transport:** use bounded base64 PNG in the private RPC envelope
  for the spike. The complete UTF-8 response is capped at 6 MiB; capture
  dimensions/pixels and PNG bytes are bounded before/after allocations.
- **D3 publishing/runtime:** evaluate the checked-in .NET 8 single-file
  settings with `publish.ps1`; move the baseline to .NET 10 LTS before
  production. Native extraction and clean-machine behavior remain unverified.
- **D4 supervision:** keep cancellation control out of the UIA lane; settle
  known outcomes, spend queued mutation snapshots, and force-restart a helper
  after the 2 s grace. The spike's bounded writer fails closed under blocked
  stdout; a Windows Job Object or independent parent watchdog remains a
  production hardening item.
- **D5 code home:** keep the prototype under `experiments/maka-cu-windows/`
  until all six checks and clean-machine evidence pass.
- **D6 Go boundary:** no Go forwarding helper is justified by current local
  evidence; revisit only with measured packaging or integration constraints.

Recommendation: **hold production enablement; the feasibility gate is not
complete**. The local fixture and published artifact checks pass, but this is
an Insider development machine. Same-window control replacement, clean-machine
evidence, and packaging measurements remain open under #4318. A supported-release
run and stronger OS-level parent ownership should be addressed before rollout.
Signing is deferred production distribution work, not an additional spike gate.
