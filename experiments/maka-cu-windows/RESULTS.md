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

# Local spike results

Run date: 2026-08-31 (Asia/Shanghai). Environment: Windows 11 Pro Insider
Preview x64 build 10.0.26220, interactive session 3; Node.js 24.19; .NET
SDK 8.0.421; target `net8.0-windows10.0.22621.0`; Windows SDK reference
10.0.22621.56. This is development-machine evidence, not clean-machine or
supported-release certification.

## Build and package

Both projects built with `dotnet build ... -c Release --no-restore`: 0
warnings, 0 errors. `publish.ps1` then produced self-contained `win-x64`,
single-file, untrimmed artifacts (`distributionReady: false`). The manifest
records helper 188,261,839 bytes, SHA-256
`C20E7649CA2B4C046110ABF984EE7D7882FAFC2A3E6CFACD1D5D7631396293D4`, and
fixture 188,220,927 bytes, SHA-256
`CB730D4CF41C03A2EAE294AB5D76DC79F46D72097E02631D45DA8CC027E8A6A4`.

The publish used the installed .NET 8.0.421 SDK only. A clean-machine restore
and runtime test were not performed.

## Published lifecycle evidence

Command:

```powershell
node experiments/maka-cu-windows/lifecycle-driver.mjs `
  experiments/maka-cu-windows/out/publish/maka-cu-windows.exe `
  experiments/maka-cu-windows/out/fixture/maka-cu-windows-fixture.exe
```

Result: `failures=0`. The fixture reported outer `SIZE 480x360` and DWM
`CAPTURE_SIZE 464x352`; WGC returned a real decoded PNG at 464x352 (9,195
bytes). The stable LimeGreen sentinel decoded to 4,000 pixels in baseline,
covered, and uncovered frames. The run passed C4 capture and occlusion, C5a
in-flight settlement (`verified/value_set`), C5b queued cancellation with no
mutation, C5c control-plane responsiveness, C6 blocked request unsettled
through the 2-second grace and fixture survival, helper termination/restart,
and fresh readback.

The same run passed exact PID+HWND whole-window recreation checks: the old
snapshot refused with `stale_target_revalidate_failed`, the new HWND was
selected explicitly, and a fresh observe succeeded. Same-window control
replacement was not exercised. The parent probe printed
`HOST_STAGE initialized` and `HOST_STAGE observe_sent`, exited host code 77,
and the helper disappeared without the lifecycle driver killing that helper.
EOF stdin closure exited a new helper with code 0 in 10 ms. All owned fixture
and helper processes were absent after teardown.

## Protocol regressions

Command:

```powershell
node experiments/maka-cu-windows/protocol-regression.mjs `
  experiments/maka-cu-windows/out/publish/maka-cu-windows.exe
```

Result: `protocol failures=0`. A wrong method type returned JSON-RPC `-32600`
and exited cleanly; unknown cancellation id 999 emitted no notification
response and left both unrelated `debug_sleep` requests complete; 1,000
initialize messages with stdout intentionally undrained exited fail-closed
with code 2 rather than hanging indefinitely.

## Limits and decision

The experiment remains fixture-only and does not enable a Windows production
backend or use global input, screen-rectangle fallback, arbitrary app launch,
or user-window selection. Process start time and window generation are
required; unavailable identity data refuses actions. GUID tokens are unique per
snapshot, but same-value HWND reuse cannot be proven as impossible by this
fingerprint and remains a documented residual risk. A production integration
should add OS-level parent ownership (for example a Job Object), signing,
supported-release testing, and clean-machine evidence.

Recommendation: **no-go for production child issue yet** despite the local
fixture and packaged spike passing.
