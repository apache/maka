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

By default, this opt-in seven-case suite invokes the real `open-history.exe snapshot`
worker against an isolated .NET Framework WPF executable. A separate explicit
recorder mode exercises physical keyboard leases and real persisted JSONL.
Neither mode generates summaries, modifies personal configuration, or tests the frontend.
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

## Physical Recorder Mode

```powershell
$env:MAKA_HISTORY_WINDOWS_WPF_TEST = '1'
$env:MAKA_HISTORY_WINDOWS_WPF_RECORDER_TEST = '1'
$env:MAKA_HISTORY_WINDOWS_TEST_ROOT = 'C:\maka-history-lab'
$env:MAKA_HISTORY_WINDOWS_INPUT_REQUEST = 'C:\maka-history-lab\fresh-wpf-input-request.json'
node --test apps/desktop/scripts/computer-history-windows-wpf.test.mjs
```

The request parent directory must exist and the request file must not already
exist. The external owner runs the existing virtual-device driver against that
same file. Recorder mode replaces, rather than runs alongside, the snapshot
matrix. Do not combine it with peer, selection-only or visible-only diagnostics.
Run this suite sequentially with other foreground acceptance.

Two ordinary TextBoxes share the same real root HWND. Their names and
AutomationIds never contain body markers. The recorder starts paused in a
fresh allowlisted home; an actual useful-body JSONL observation is required
before any identity inspection or physical input. An in-fixture MTA then reads
only the owned focused UIA element's metadata and full runtime ID, checking its
PID, AutomationId, focus, framework and ancestor root. It neither reads UIA
values nor installs a custom provider for this mode.

| Recorder gate | Required observation |
| --- | --- |
| Initial body and physical keys | Real JSONL contains a body-only marker, then Return and Ctrl+A with exact PID/root HWND, role-only targets and the admitted body source UUID |
| Late-window physical key | Hold the same foreground field for at least 3.5 seconds, recheck its identity, then require another persisted physical Return; this tests delivery after an idle interval, not an attested private lease age |
| Same-host focus invalidation | Receipt of a physical Return moves focus from field one to field two synchronously in WPF; no pending key may persist during the six-second observation; distinct field runtime IDs share the same root ID |
| New-field and body recovery | Fresh second-field body and physical Return/Ctrl+A succeed; an in-place body edit preserves field identity and fresh input succeeds |
| Password suppression | Add a visible PasswordBox without replacing the active TextBox, prove direct snapshot suppression, deliver a physical key, require zero new persisted context plus increased suppression and healthy recorder status |
| Password recovery | Remove the password, observe a fresh allowed body and accept another physical Return |
| Pause revocation | Deliver and witness a Return while runtime is paused; no new events may persist |
| Text-off and numeric selection | Resume with new text-off-only content; physical keys produce metadata-only actions; physical Ctrl+A produces an exact numeric UTF-16 range in JSONL matching the fixture's selection start/length, without selected text or AX body |
| Text-on recovery and shutdown | Remove text-off-only content while paused, enable text, resume, observe a fresh body/key, then require graceful EOF, stopped health, released recorder admission and sealed JSONL |

Numeric WPF selection is a separately named, executed Node TODO subtest,
not a skip or a counted pass. Its exact acceptance assertion is unchanged;
failure is retained in `case.failed` evidence with `numericCoveragePassed=false`,
but does not fail the overall action/privacy suite or stop subsequent text-on
recovery and sealed shutdown checks. The current native
implementation routes `captureText=false` to standard native Edit selection
and omits WPF ranges. Exact text-free UTF-16 WPF offsets remain an unresolved
coverage requirement: WPF `TextUnit.Character` represents linguistic caret
units, so counting endpoint movements does not establish UTF-16 offsets.
No safe text-free API has been established for this requirement; this harness
does not prescribe an endpoint-counting implementation or permit `GetText`
as a metadata workaround. A selection-state-only result is a possible
alternative pending an explicit contract decision, not satisfaction of the
current numeric gate. The fixture's own numeric selection receipt is an
acceptance oracle, never production authority. A missing exact range is the
known TODO coverage gap. Physical input receipts, content exclusion, healthy
recorder status, recovery and shutdown remain mandatory outside that subtest;
their failures still fail the run. Remove the TODO annotation only after the
native implementation satisfies the unchanged gate in actual acceptance.

Separate `snapshot-lease` probes compare the native worker's complete
element/document IDs with the fixture's UIA field/root IDs before inputs to
each field. These probes are explicitly logged as
`standalone-lease-field-identity-only`; they do not prove the recorder used
that specific worker or authorize input on its behalf. Recorder acceptance
requires the subsequent physical-device actions in its own sealed JSONL.
No runtime/document IDs or worker identity fields may be persisted there.
The initial body precedes all UIA identity probes, but subsequent input results
are not a claim of untouched cold-provider activation.

### External Driver Contract

The request retains the interactive suite's fields:
`id`, `name` (`return` or `shortcut`), `deadline` in epoch milliseconds,
`processIdentifier`, `windowID`, `inputWindowID`, `foreground` and
`witnessedAt`. The harness also retains `publishedAt` from the first actual
request publication; later freshness heartbeats never advance that boundary.
For WPF, `inputWindowID === windowID` is required.
Additional `field`, `runtimeId` and `rootRuntimeId` describe the exact
verified semantic field. A 50 ms fixture heartbeat republishes the request
only while the same owned field actually has foreground keyboard focus.

Readiness additionally carries `witnessedQpcNs`, a canonical positive decimal
UInt64 string. In recorder mode, Node 24.18.1 x64 compares it as BigInt with
`process.hrtime.bigint()`: age must be inclusively 0 through 750,000,000 ns.
The fixture samples before `Ready()` using high-resolution `Stopwatch` QPC
and the exact libuv Windows division order:
`(ulong)((double)counter / ((double)frequency / 1000000000))`.
Low-resolution Stopwatch and 32-bit fixture execution fail closed. Both
processes must share the same Windows boot; this is not a cross-host clock.
Double conversion quantizes large counters, so nanosecond units do not imply
nanosecond resolution. Future observations reject without tolerance or restamping.

Only fixture-to-Node readiness freshness uses this monotonic candidate.
`witnessedAt` remains the original UTC evidence, and UTC publication,
request deadlines, physical receipts and native-event attribution below
retain their existing checks. This does not eliminate all wall-clock failures
or change the external driver's clock contract. Generated C# conversion
equivalence and actual Windows acceptance remain required before native use;
local JavaScript tests alone do not establish them.

The driver validates current PID/HWND, freshness (the existing 750 ms bound),
original deadline and request ID, sends each request once via the owned QEMU
device, and releases modifiers. No `SendInput`, key-event injection or
accessibility action is a positive-input substitute. The driver retains its
existing `return` and `shortcut` commands; no pointer support is needed here.
Its overall run deadline must cover the 200-second recorder work budget;
the earlier interactive driver's 100-second default is not sufficient for
worst-case WPF gates. Individual requests retain their 12-second deadline.
The fixture independently emits a correlated `input.received` only after the
physical WPF key handler ran, including the original and resulting fields and
post-input numeric selection. `keyDownAt` is sampled in that handler before
focus changes or deferred readback; `settledAt` and `timestamp` describe the
later selection readback. Both millisecond times must belong to the original
published request/deadline and appear in order. The native action timestamp
must lie in the inclusive `publishedAt` to `keyDownAt` interval, without a
grace period. An old timestamp cannot satisfy a later request through a fresh
event ID or unchanged source UUID. The fixture does not mark the event handled
or fabricate an application success.

After delivery the request keeps its already-serviced ID and adds
`completed: true`; the existing driver's seen-ID guard ignores it. Normal or
failed teardown publishes `{ "done": true }`. Both runner and driver retain
their own deadlines; losing focus or a fresh witness fails instead of
reacquiring an unrelated window. The harness never invokes the external
driver or operates the guest itself.

Every physical request remains in a ledger through sealed readback, including
focus-change, password and pause rejections. Positive requests require exactly
one matching action with the observed body source, original receipt interval,
PID/HWND, role, modifiers and text-consent mode. Rejected requests require zero.
The sealed action must equal the action observed during its request; extra,
changed, delayed, missing or unattributed actions fail acceptance. Distinct event
IDs alone are not an exactly-once check. The six-second negative observation
windows remain in addition to this final reconciliation.

Completion-file writes and disarm are independently attempted. Teardown likewise
continues recorder/fixture cleanup after a failed `done` write and closes the
evidence descriptor even when final evidence writes fail. Cleanup failures fail
the run and preserve the original physical failure when present.

Recorder evidence additionally includes runtime/health, per-key receipts,
standalone identity frames, physical rejection windows, metadata-only ranges
and final sealed segments. Denied-password, password-state body and
text-off-only markers must be absent from every persisted event, including
later recovery. Fixture commands deliberately retain synthetic canaries in
the diagnostic log, separately from recorded JSONL.

### Recorder Validation Status

This mode is an acceptance implementation, not a reported Windows pass.
The September 16, 2026 harness repair adds three non-Windows regression tests
for receipt validation, request/sealed-action reconciliation and cleanup
continuation. They pass locally; the opt-in Windows test remains skipped.
The pre-repair extracted physical matcher accepted an old timestamp with a fresh
ID and distinct-ID duplicates, and a failed completion write skipped disarm.
These false-positive gaps do not explain the missing first Return in `MeSt1C`.
That run remains a failed physical acceptance, not a pass.

Local validation includes JavaScript syntax, Biome, scoped diff whitespace
and all three ASF header checks. Both explicit modes reject
non-Windows execution before side
effects. Two Node 24 subprocess checks confirmed that a failed TODO executes,
is counted separately and permits recovery with exit zero, while a mandatory
privacy assertion failure still exits nonzero. These checks do not establish Windows WPF compilation, physical input
delivery, numeric selection or recorder lease correctness. The native owner
performs the staged Windows run and reports its actual evidence and cleanup
result. A passed key/privacy/lifecycle result with a failed numeric TODO must
be reported as action/privacy acceptance with a known exact-coordinate coverage
gap, even when Node exits zero. Report the TODO count and `numericCoveragePassed`
separately; a zero exit does not establish full WPF selection coverage.

## Cases

| Case | Required evidence |
| --- | --- |
| Scrolled TextBox/RichTextBox | Mixed UTF-16 document with tail witness beyond 32 KiB; top, visible tail, restored top; offscreen counterpart absent; partial flag retained |
| Nonselectable controls | Normal Button without TextPattern and a Button peer returning `E_NOTIMPL` from GetSelection retain body and edits, omit selection, and prove the unsupported method was actually called |
| TextBox | Body-only marker followed by an in-place multilingual edit; old body absent |
| RichTextBox / FlowDocument | Independent body-only baseline and edit through the real provider |
| PasswordBox | Same readable TextBox, body and window; add a visible PasswordBox sibling; complete snapshot suppressed; remove it and recover a new body |
| Text capture off/on | Matched useful body first, admitted metadata without text, useful body again |
| Application block/unblock | Matched useful body first, block overrides the allowlist, complete suppression, useful body again |

All cases check the exact fixture PID/HWND, title, supplied snapshot source ID,
known native source, and empty domain list. Body markers occur only in actual
editor content or visible button content, never in titles, AutomationId, or
an explicitly supplied accessible name.
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

`MAKA_HISTORY_WINDOWS_WPF_SELECTION_TEST_ONLY=1` runs only the nonselectable
regression for before/after helper comparison. It is not a full-suite result.
The synthetic unsupported TextPattern is a controlled error injection, not
a claim that ordinary WPF Buttons implement TextPattern.
`MAKA_HISTORY_WINDOWS_WPF_VISIBLE_TEST_ONLY=1` similarly selects only the
scroll regression. Fixture character rectangles and scroll offsets establish
that the requested witness is actually visible before capture; readback must
remain identical afterward. No UIA peer diagnostic is needed to drive scrolling.

## Clean Windows Result

On 2026-09-15, visible-range run `doFvkh` passed all seven cases in 41.660
seconds (scroll case 6.189 seconds), without peer diagnostics. Both TextBox
and RichTextBox captured the tail beyond the 32-KiB prefix budget and returned
to the top without retaining the previous viewport. The earlier baseline
`zcmKXx` failed because its top snapshot included the offscreen tail.

On 2026-09-15, final run `RAjoyQ` passed all six cases in 35.031 seconds
without peer diagnostics. The new optional-selection case passed in 2.826
seconds; the same regression against the pre-fix helper (`6BP3Kz`) failed
with `uia_provider_unavailable`. The final case requires both absent-pattern
and explicitly unsupported-selection controls to retain useful body and edits,
while the synthetic provider counter proves `GetSelection` was invoked.

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
Recorder mode has a separate 200-second work budget, 240-second Node limit
and 205-second fixture watchdog; production native deadlines are unchanged.

The fixture retains its Node parent's process handle and verifies the same
session. An independent watchdog exits on parent death or at 125 seconds, and
forces exit if EOF cannot shut down the WPF dispatcher within 1.5 seconds.
Normal cleanup sends EOF and waits for exit/pipes. A stuck fixture is terminated
only through its owned ChildProcess, and forced termination fails the run.
There is no process-name kill or desktop/UAC/security-policy modification.

In snapshot-only mode, the final check requires the History home to contain
only the three fixture policy/control files, with no recorder runtime, lock,
or segment files. Recorder mode instead checks real sealed segments and the
stopped recorder/admission state.
`evidence.jsonl`, generated executable, per-case outcomes, timings and native
stdout/stderr are retained under the printed run directory. Do not mistake the
synthetic evidence log for a recorded user-history segment.

## Coverage Limits

This suite tests .NET Framework WPF TextBox, RichTextBox and PasswordBox only.
It does not establish Win32 RichEdit, WinUI/packaged Notepad, Office, terminal,
Electron/WebView2 or browser-origin/private-mode support. The default snapshot
matrix does not establish physical input, selected-text, or recorder source-UUID
lifecycle support. A standalone worker receives a caller-generated source UUID;
UUID round-trip is not proof of recorder identity stability. Only a separately
successful physical recorder run establishes its listed action/range/lifecycle gates.

RichTextBox may expose a provider/tree shape that the current bounded native
reader cannot safely capture. Such a result remains an explicit failing
coverage case until the native owner investigates it; do not replace the
FlowDocument body with an accessible-name string to make the test pass.

The suite logs session ID and enabled administrator membership, but these do
not fully attest token integrity/UIAccess or ordinary-user support. Main must
verify the actual helper/fixture tokens for a standard-user acceptance run.
With UAC disabled, a Limited task on an admin account is not sufficient.

Local non-Windows validation checks receipt/ledger/cleanup behavior, syntax,
opt-in rejection and skipped native discovery. WPF compilation and real provider
results require the Windows foreground run and must be reported separately.
