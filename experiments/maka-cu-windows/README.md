# maka-cu-windows feasibility spike

This private experiment supports apache/maka#4318. It is a supervised,
fixture-only feasibility spike for long-lived C# and direct-COM Rust helpers on
Windows. It does not enable a Windows product backend or change the public
protocol. The default action tier has no keyboard, pointer, coordinate,
`PostMessage`, foreground, or screen-rectangle fallback; the explicitly named
compatibility tier permits only one-shot authorized Unicode/Enter `SendInput`
after exact foreground/focus confirmation.

The local machine has only .NET SDK 8.0.421, so the spike targets
`net8.0-windows10.0.22621.0`. .NET 8 is temporary evidence only; a production
follow-up must evaluate .NET 10 LTS and rebuild self-contained artifacts for
runtime patching. No SDK was installed globally for this spike.

## Components

- `src/Program.cs`: line-delimited JSON-RPC 2.0, an MTA UIA lane, bounded
  request/snapshot registries, strict process-start/window-generation identity,
  opaque snapshot tokens, typed readback outcomes, and cancellation settlement.
- `src/ScrollReadback.cs`, `scroll-readback-cases.json`, and
  `scroll-readback-harness.mjs`: shared directional-scroll verification policy
  and real delayed-provider regression. Private contract revision 0.1.1 removes
  the ScrollItem fallback from directional `scroll`; see `PROTOCOL_CONTRACT.md`.
- `src/WgcCapture.cs`: target-window `CreateForWindow(HWND)` capture and a
  D3D11 staging-texture PNG encoder. Capture has no rectangle fallback and
  reports `capture_unavailable` on failure.
- `fixture/HangWindowFixture`: purpose-built WinForms fixture. `freeze` blocks
  its UI thread so UIA provider calls can hang; `recreate` replaces its HWND;
  `cover` tests target capture under occlusion.
- `fixture/WpfTaskFixture`: deterministic WPF fixture exposing Value,
  Toggle, SelectionItem, and Scroll patterns, plus a status readback label.
- `driver.mjs`: safe smoke flow. It accepts only the exact fixture HWND and
  never scans or mutates user windows.
- `lifecycle-driver.mjs`: C4–C6, identity, and parent-death reproduction
  scenarios. It owns and tears down all fixture/helper processes.
- `parent-probe.mjs`: short lived host used to prove helper parent-death
  cleanup after an initialized, blocked observe.
- `protocol-regression.mjs`: malformed-method, unknown-cancel, and EOF plus
  stdout-backpressure regressions without a GUI.
- `protocol-contract.json` / `PROTOCOL_CONTRACT.md`: language-independent
  wire, timeout, safety, cancellation, and lifecycle contract.
- `comparison-harness.mjs`: one language-blind entry point that runs the same
  fixture and drivers against two opaque helper artifacts and records raw,
  structured results.
- `app-task-harness.mjs`: language-blind WPF task matrix for set text, semantic
  click, select, toggle, scroll, typed unsupported Enter, explicit compatibility
  text/Enter, and negative authorization checks.
- `browser-task-harness.mjs` / `real-app-probe.mjs`: temporary-profile Chrome
  smoke probe plus read-only Chromium/LibreOffice/WinUI-UWP availability
  evidence; blocked capabilities remain blocked.
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

## C# / Rust comparison run

After publishing the C# helper/fixture and building the Rust release helper:

```powershell
$rust = 'experiments/maka-cu-windows-rust/target/release/maka-cu-windows-rust.exe'
$cs = 'experiments/maka-cu-windows/out/publish/maka-cu-windows.exe'
$fixture = 'experiments/maka-cu-windows/out/fixture/maka-cu-windows-fixture.exe'
node experiments/maka-cu-windows/comparison-harness.mjs `
  $cs $rust $fixture `
  --out experiments/maka-cu-windows/comparison-results.json
```

The result is shaped as `subjects[].artifact` plus nested
`subjects[].runs[]`. Each artifact and the fixture include path, size, SHA-256,
and last-write time. Each run includes the exact command/arguments, raw
stdout/stderr, duration, exit code/signal, and parsed checks. The top level
records host Windows build/architecture, Node version, contract/harness SHA-256,
and start/finish timestamps. Subject, driver, and per-check summaries each
report pass/fail/blocked counts. Missing expected checks, missing summary
sentinels, any emitted `FAIL`, non-zero exit, timeout, or empty output fails
closed; blocked environment evidence is never counted as pass.

## Current local evidence (Windows 11 Insider 10.0.26220, x64)

| Check | Result | Evidence or limit |
| --- | --- | --- |
| 1. handshake | pass | Protocol `maka.cu.windows/0`; 10 s handshake / 20 s request / 2 s cancel grace declared. |
| 2. MTA UIA observation | pass on fixture | Dedicated MTA lane, bounded shallow tree, exact PID/HWND/start time/generation. |
| 3. semantic action | pass on fixture | `ValuePattern.SetValue`, pre-dispatch snapshot spend, strict revalidation, readback; duplicate tokens refuse. |
| 4. WGC target capture | pass on fixture | `CreateForWindow(HWND)` plus D3D11 staging readback produced real PNG bytes (464x352, 9,195 bytes); decoded LimeGreen sentinel remained present under an occluding fixture cover and after uncover. No rectangle fallback. |
| 5. cancellation settlement | pass on fixture | In-flight post-dispatch cancellation settles the original request with `verified`; queued cancellation settles `refused/cancelled_before_dispatch` and readback proves no mutation. |
| 6. hung-provider recovery | pass on fixture/helper | Frozen fixture remains alive; supervisor kills helper after 2 s, confirms exit, restarts with a new generation, and old snapshots are unknown. |
| identity cases | pass on fixture | Whole-window recreation returns a new HWND and rejects the old snapshot; same-window control replacement was not exercised. New explicit selection is required. |
| parent death | pass on fixture/helper | Dedicated parent probe completed initialize and a blocked observe, exited host code 77, and the helper disappeared without the lifecycle driver killing that helper PID. EOF and fail-closed stdout backpressure also exited within the deadline. A production integration should still add independent OS-level supervision. |

The latest completed two-subject comparison artifact uses the correct
HangWindow fixture: both subjects pass lifecycle `34/34` and protocol
regression `3/3` (74/74 checks). An earlier post-change attempt accidentally
used the WPF fixture with the HangWindow-only lifecycle driver and timed out;
that obsolete artifact was blocked and was not counted.
`summary.subjects`, `summary.drivers`, and `summary.checks` are the
authoritative aggregate fields.

These are development-machine results, not clean-machine or supported-release
certification. A clean machine with no .NET runtime/SDK and an interactive
desktop has not been run here, so the spike is not a production go decision.

## Real-application matrix status

The WPF fixture task artifact is `app-task-results.json`; the result separates
`executionState` from `contractConformance`. Only verified actions count in
execution success; unsupported Enter and focus-refused compatibility input are
`executionState=blocked` while their typed safety contract is
`contractConformance=pass`, and an unconfirmed mutation is
`executionState=unknown`. The latest WPF artifact has eight tasks per helper:
`5/8` pass, `2/8` blocked, and `1/8` unknown; all 16 task records conform to
the safety contract. Three negative authorization checks per helper also pass.
Enter is intentionally blocked (the click target is a
Toggle-backed semantic click control because WPF Button Invoke was not exposed
consistently by this desktop provider). The local Chrome artifact is
`browser-task-results.json`: Chrome 152.0.7977.64 was launched with a fresh
temporary profile. The C# helper saw no UIA Value/Invoke pattern; the Rust
helper exposed only the click pattern. The overall Chromium matrix is
therefore `blocked`, not pass (latest C# `0/5`, Rust `1/5` execution success;
remaining tasks are blocked). The read-only
probe found no LibreOffice executable. Calculator, Notepad, and Paint AppX
packages were present, but no isolated WinUI/UWP task was launched in this
step; they remain `blocked`. No existing profile or user document was opened
  or modified.

### 2026-09-02 browser/security follow-up

The browser harness now uses a loopback HTTP fixture, per-run marker, spawned
Chrome PID/HWND identity evidence, independent page oracle, and records both
default and `--force-renderer-accessibility` configurations for each helper.
The measured matrix is 4 configurations / 20 tasks: `0/20` were dispatched
because Chromium exposed only browser-shell UIA nodes (C# observed 9 nodes and
Rust 38 shell nodes); all unexecuted tasks are explicitly
`executionState=blocked`, `contractConformance=not_tested`. This is a provider
capability/environment result, not a contract pass, and does not claim the
complete #4318 matrix or clean-machine completion. `distributionReady=false`.

The compatibility-input safety follow-up adds OS-random Rust authorization
tokens, bounded/expired grant cleanup, final foreground/focus/identity checks,
post-dispatch identity uncertainty, and preserves the unavoidable OS focus
race limitation. The earlier WPF artifact remains historical and was not
retested in this follow-up.

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

Recommendation: **no-go for production child issue yet**. The local fixture
and published artifact checks pass, but this is an Insider development machine;
clean-machine and supported-release interactive evidence, signing, and a
production OS-level parent ownership mechanism remain open.
