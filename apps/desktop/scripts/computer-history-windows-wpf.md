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

# Windows WPF History Canary

This opt-in five-case suite invokes the real `open-history.exe snapshot` worker
against an isolated .NET Framework WPF executable. It does not start a recorder,
generate summaries, modify personal configuration, or test the frontend.
Run foreground suites sequentially in an unlocked Windows interactive session.

```powershell
$env:MAKA_HISTORY_WINDOWS_WPF_TEST = '1'
$env:MAKA_HISTORY_WINDOWS_TEST_ROOT = 'C:\maka-history-lab'
node --test apps/desktop/scripts/computer-history-windows-wpf.test.mjs
```

The test root must already exist on local NTFS. Node 24 and Windows PowerShell
5.1 with .NET Framework WPF are required. The companion script compiles a
uniquely named C# Windows executable using `Add-Type`; it does not install any
packages. Optional `MAKA_HISTORY_WINDOWS_HELPER` must name an absolute staged
helper path. The default is `apps/desktop/resources/bin/open-history.exe`.

## Cases

| Case | Required evidence |
| --- | --- |
| TextBox | Body-only marker followed by an in-place multilingual edit; old body absent |
| RichTextBox / FlowDocument | Independent body-only baseline and edit through the real provider |
| PasswordBox | Same readable TextBox, body and window; add a visible PasswordBox sibling; complete snapshot suppressed; remove it and recover a new body |
| Text capture off/on | Matched useful body first, admitted metadata without text, useful body again |
| Application block/unblock | Matched useful body first, block overrides the allowlist, complete suppression, useful body again |

All cases check the exact fixture PID/HWND, title, supplied snapshot source ID,
known native source, and empty domain list. Body markers occur only in actual
editor content, never in titles, AutomationId, or accessible names.
The fixture acknowledges layout, actual foreground/focus, editor instance and
control readback. Non-mutating inspection before and after each native call
must agree; it never reacquires focus to conceal a lost foreground window.
The fixture supplies no text to native capture. Multiline body assertions
normalize CRLF to LF without dropping internal whitespace or content.

PasswordBox is a separate WPF control type, not a TextBox whose role is toggled.
The test adds/removes that visible sibling without replacing the matched
TextBox or moving focus into PasswordBox. This exercises whole-window password
suppression, including an unfocused sensitive sibling. The denied-only synthetic
password must not occur in successful native output or recovery snapshots.
Fixture commands/evidence intentionally retain synthetic inputs for diagnosis.

An allowed `null` or missing body is a failing native-family coverage result,
not an automatic skip. A timeout/provider error is always a failure, never
successful password/app suppression. Independent subtests continue when the
fixture remains usable, so unsupported RichTextBox does not silently erase
TextBox results. The suite uses no provider fallback or forced accessibility
activation.

## Clean Windows Result

On 2026-09-15, the main task reported clean Windows run `fOgDqe`: all five
cases passed in 57.064 seconds, with no peer diagnostics enabled
(`MAKA_HISTORY_WINDOWS_WPF_PEER_DIAGNOSTICS` was not enabled). This covers
TextBox and RichTextBox body edits, matched PasswordBox suppression/recovery,
text capture off/on, and application block/unblock.

The accompanying native fix addresses WPF TextBox template children.
TextBox inherits visual-child peer enumeration and can expose a ScrollViewer
even though its ValuePattern returns the editor's own `Text`. The previous
raw-leaf-only rule skipped that value. The native reader now queues non-leaf
WPF TextBox own-values until the complete window walk and tree validation
succeed. Identity, ancestry and password checks surround each value read,
followed by a second tree validation. It does not enable generic container
text aggregation.

This is standard-control acceptance in the tested Windows session, not proof
of standard-user execution, custom-template coverage, or general WPF
application compatibility. After the shared metadata-read batching change,
clean run `4frkEO` again passed all five cases in 32.86 seconds with peer
diagnostics disabled.

## Isolation And Cleanup

Only the fresh `win32.maka-history-wpf-<random-token>` app ID is allowlisted.
Application and URL defaults deny observation; `powershell.exe`, unrelated
windows, and personal history are not admitted. All policy files and evidence
live in a new per-run directory. WPF needs no browser profile; it uses synthetic
in-memory documents and does not open user files. The software-rendering
preference applies only to this fixture process.

Work has a 120-second budget inside a 180-second Node test limit. Fixture
compilation is bounded to 20 seconds, each native command to five seconds, and
each fixture command to three seconds. Every snapshot is a fresh process,
retaining the native worker's own parent/deadline checks.

The fixture retains its Node parent's process handle and verifies the same
session. An independent watchdog exits on parent death or at 125 seconds, and
forces exit if EOF cannot shut down the WPF dispatcher within 1.5 seconds.
Normal cleanup sends EOF and waits for exit/pipes. A stuck fixture is terminated
only through its owned ChildProcess, and forced termination fails the run.
There is no process-name kill or desktop/UAC/security-policy modification.

The final check requires the History home to contain only the three fixture
policy/control files, with no recorder runtime, lock, or segment files.
`evidence.jsonl`, generated executable, per-case outcomes, timings and native
stdout/stderr are retained under the printed run directory. Do not mistake the
synthetic evidence log for a recorded user-history segment.

## Coverage Limits

This suite tests .NET Framework WPF TextBox, RichTextBox and PasswordBox only.
It does not establish Win32 RichEdit, WinUI/packaged Notepad, Office, terminal,
Electron/WebView2, browser-origin/private-mode, selected-text, or recorder
source-UUID lifecycle support. A standalone worker receives a caller-generated
source UUID; UUID round-trip is not proof of recorder identity stability.

RichTextBox may expose a provider/tree shape that the current bounded native
reader cannot safely capture. Such a result remains an explicit failing
coverage case until the native owner investigates it; do not replace the
FlowDocument body with an accessible-name string to make the test pass.

The suite logs session ID and enabled administrator membership, but these do
not fully attest token integrity/UIAccess or ordinary-user support. Main must
verify the actual helper/fixture tokens for a standard-user acceptance run.
With UAC disabled, a Limited task on an admin account is not sufficient.

Local non-Windows validation checks syntax, opt-in rejection and skipped test
discovery only. WPF compilation and real provider results require the Windows
foreground run and must be reported separately.
