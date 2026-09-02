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

# Cross-machine Computer Use test report — 2026-09-02

This report records the latest Windows 11 x64 validation of the C# and Rust
Computer Use comparison spike on branch `codex/maka-cu-rust-comparison`.
All application tests used isolated temporary fixtures, profiles, or documents;
no existing user Chrome profile or user document was opened or modified.

## Environment

| Item | Value |
| --- | --- |
| Windows | Windows 11 Pro `10.0.26200`, x64 |
| Node | `v22.16.0` |
| .NET SDK | `10.0.400` |
| Rust | `rustc 1.89.0`, cargo `1.89.0` |
| LibreOffice | `26.8.0.3`, `D:\soft\program\soffice.exe` |
| Chrome | `152.0.7977.x`, isolated temporary profiles only |
| Electron | Repository Electron runtime available |
| WinUI/UWP | Calculator, Paint, and Notepad packages available |

## Build and protocol results

- C# helper, HangWindow fixture, and WPF fixture build successfully with .NET
  SDK 10.0.400 and zero warnings or errors.
- `cargo fmt --check` passes.
- `cargo clippy --all-targets -- -D warnings` passes.
- Rust tests pass: 8 unit tests plus 3 protocol tests.
- The published C# and Rust helpers each pass lifecycle `34/34` and protocol
  `3/3`; the combined comparison result is `74/74`.

## Application matrix

| Matrix | Execution | Contract | Classification |
| --- | ---: | ---: | --- |
| WPF fixture | 12 pass, 2 blocked, 2 unknown | 16/16 pass | Each helper is 6/8 execution; typed Enter is intentionally blocked and compatibility Enter remains unknown. |
| Chromium semantic tasks | 18/18 pass | 18/18 pass | Three repetitions per helper in `force-renderer-accessibility-complete` mode. |
| Chromium navigation | 12 pass, 6 unknown | 12 pass, 6 not-tested | The independent page oracle confirms 18/18 navigations; helper-side Enter remains `unknown` and is not upgraded. |
| LibreOffice | Observation/capture available | Write not tested | Isolated temporary Writer document; no safe document `ValuePattern` was exposed. |
| Calculator | Observe and semantic action pass | N/A | Fresh HWND/PID/start-time/window-generation identity was checked. |
| Notepad | Observe and isolated text action pass | N/A | Temporary document only; `Document`/`ValuePattern` was verified. |
| Paint | Observation smoke pass | Mutation not tested | No mutation was attempted without a safe semantic target. |
| Electron fixture | Observation smoke pass | Mutation not tested | Local fixture and isolated user-data directory only. |

The `unknown` and `blocked` outcomes above are intentional contract outcomes,
not greenwashing: page-oracle success does not become helper verification, and
no mutation was retried or authorized merely to change an outcome.

## Published artifacts

| Artifact | Size | SHA256 |
| --- | ---: | --- |
| C# `maka-cu-windows.exe` | 199,642,135 bytes | `A705BCF778CD15187AD7FECF00AF0017E06279B8393588ECEED557947EEDE576` |
| Rust `maka-cu-windows-rust.exe` | 533,504 bytes | `E297321C6D74F8B34FC66261B21E06FDDE894A7E28CF5DA115C06B10D3190ADD` |
| HangWindow fixture | 142,690,490 bytes | `D753288D843A8D6331D6ED33CA792C76B9B2DD8EC7FEFCF2019D0CB716CF61BF` |

The package is self-contained `win-x64`, single-file, and trimming-disabled.
It is intentionally unsigned and records `distributionReady=false`; this is
experimental evidence, not a production release certification.

## Performance samples

- Three cold handshakes: C# `69–80 ms`, Rust `39–41 ms`.
- Process working set: C# approximately `22.7 MiB`, Rust approximately `7.2 MiB`.
- First WGC frame from the fixture: C# `62 ms`, Rust `239 ms`.

## Final classification

1. Reproduced: fixture/protocol baseline, WPF semantic actions, Chromium
   semantic actions, Chromium page-oracle navigation, and the listed real-app
   observation/action smoke tests.
2. Environment blocking: no installed-app discovery blocker remains. The
   unsupported or unsafe real-app mutations are recorded as not tested, not
   failures.
3. Code defects fixed: .NET 10 targeting and metadata, .NET 10 interop
   warning, LibreOffice discovery, cold UIA observation budget, descendant
   discovery, and Notepad document-value probing.
4. Further source changes: no additional defect is indicated by this matrix.
5. Evidence quality: suitable as clean-machine runtime/package evidence for
   this experiment, but not as signed production-release or arbitrary-app
   certification.

## Evidence files

- `comparison-results-cross-machine.json`
- `app-task-results-cross-machine.json`
- `browser-results-semantic-cross-machine-latest.json`
- `browser-results-navigation-cross-machine-latest.json`
- `observe-tree-results-cross-machine.json`
- `real-app-probe-cross-machine.json`
