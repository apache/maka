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

# Synthetic Windows Computer History Acceptance

This opt-in backend test runs the actual staged `open-history.exe` recorder
against controlled WinForms windows. It does not start Maka, use a browser,
operate a VM, or access an existing history home.

## Run

Use Node 24 in an unlocked, interactive Windows desktop with Windows PowerShell
5.1 and .NET Framework available. Stage the helper with the existing
`build-computer-history-helper.mjs` workflow first. Run from the repository root
in a dedicated test desktop. Use a Limited interactive task (run only while
the test user is logged on), not a service, elevated task or non-interactive
remote shell. Leave the fixture foreground during the test.

```powershell
$env:MAKA_HISTORY_WINDOWS_INTERACTIVE_TEST = '1'
try {
    node --test --test-concurrency=1 apps/desktop/scripts/computer-history-windows-interactive.test.mjs
} finally {
    Remove-Item Env:MAKA_HISTORY_WINDOWS_INTERACTIVE_TEST
}
```

Without the opt-in, Node runs the deterministic receipt/action checks, skips
native acceptance and launches nothing. Opting in on a non-Windows host fails.
Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `MAKA_HISTORY_WINDOWS_TEST_ROOT` | Existing absolute local NTFS parent directory; defaults to the OS temporary directory. Each run creates a new child. |
| `MAKA_HISTORY_WINDOWS_HELPER` | Absolute path to an actual built helper; defaults to `apps/desktop/resources/bin/open-history.exe`. |
| `MAKA_HISTORY_WINDOWS_INPUT_REQUEST` | Opt-in absolute synthetic request file for an external virtual-device input driver; not needed for ordinary body tests. |
| `MAKA_HISTORY_WINDOWS_INPUT_ONLY` | Set to `1` with the request file to stop after action acceptance and normal recorder cleanup. |
| `MAKA_HISTORY_WINDOWS_RICH_EDIT_TEST` | Set to `1` with input-only mode to exercise partial RichEdit body, hidden runs, physical input, privacy and text-policy recovery. |
| `MAKA_HISTORY_WINDOWS_METADATA_INPUT_TEST` | Set to `1` with input-only mode to exercise standard Edit numeric selection without body reads and metadata-only physical actions. |

UNC, network drives, non-NTFS storage and reparse-point homes are rejected by the
actual helper's `validate-home`, before recording. Do not point the helper
override at a mock. No dependencies, elevation, services or scheduled tasks are
installed by the harness.

The optional input sequence requests Return, Ctrl+A, Return after six idle
seconds, an out-and-back drag, and a click. The request file carries a unique request ID, deadline,
fixture PID, window/child HWND, point, and refreshed foreground/pointer witness.
An external lab driver must verify the fresh fixture identity and, before
mouse-down, the exact child under the pointer. It must stop on stale witnesses,
expired requests, unexpected foreground or `{ "done": true }`. A retired
request keeps its ID with `deadline: 0` and `retired: true`: a driver that
already sent it waits for the next ID; an unsent expired request must fail.
Only fresh fixture heartbeats publish foreground/pointer witnesses. The driver is
responsible for its own bounded cleanup; the harness never injects input.
Use a VM keyboard/mouse or manually operated test device. Windows `SendInput`
is deliberately rejected by the recorder and cannot establish positive
physical-input acceptance. Before publishing a request, the harness arms its
ID and original deadline in the focused fixture. The fixture emits exactly one
press and one release receipt with that ID, timestamp and exact target; stale,
unarmed, duplicate or wrong-target receipts fail. Retirement acknowledges that
all modifiers and buttons are released before the next request can arm.
Passing additionally requires exactly one action-only JSONL event within that
request's original publication/release interval, with the original source and
exact child target. Every later poll and sealed readback checks the complete
action sequence for delayed duplicates or unrequested events, without a new
fixed sleep. These receipts witness delivery, not editor operation success.
This contract is limited to isolated
synthetic desktops and does not authorize operating personal applications.

RichEdit mode keeps a hidden formatted run beside a visible body marker and
an independently visible, unfocused RichEdit sibling. Both visible bodies
must reach the direct snapshot and actual recorder with truncation set;
neither the hidden run nor Rich selection may be retained. The cold recorder
must first persist the body and sibling with the hidden marker excluded, before
any auxiliary provider or direct snapshot probe. An observed recorder capture
failure aborts body acceptance; no auxiliary warm-up or harness retry follows.
The harness then pauses and waits for published paused state, after pending
workers are retired, before running the existing probes and direct assertions.
The paused recorder home must reject a direct snapshot with
`capture_not_admitted`. The positive direct snapshot uses a separate validated
synthetic home with byte-for-byte copies of the recorder's configuration and
consent files, its own running control, and no recorder. The optional visible
probe receives that same isolated home. Readback verifies unchanged policy and
consent, and no runtime state or segments in the probe home.
The native capture budget is unchanged. Paused probes must leave sealed event
counts unchanged. Resume must persist a new body event beyond that boundary
with a different source ID before physical requests; that resumed source starts
the uninterrupted A-to-B-to-A checks below.
Only in the synthetic
Rich editor, Enter/Ctrl+A handlers prevent their destructive default behavior
while retaining KeyDown/KeyUp receipts; no low-level hook is suppressed. Exact
text/RTF equality and hidden-marker presence are checked at arm, receipt and
retirement, so later mouse cases still exercise the hidden context.
The same-title A-to-B-to-A transition requires fresh recorder events with three
distinct source IDs; an old A marker cannot satisfy the return. A subsequent body
edit must appear in a new recorder event while retaining the returned source ID.
A visible password sibling must
cause actual worker suppression, increasing recorder suppression counts and
zero provider failures; removing it must restore useful body capture.
Both text-policy transitions are exercised through pause/resume, with
metadata-only events while text is disabled and new body after re-enabling.
Sealed JSONL must contain the useful markers and none of the hidden, password,
denied-only or text-disabled markers. This tests bounded visible runs, not
complete RichEdit text or selection support.

The input driver receives `done` after the physical sequence. The recorder
test continues its privacy, consent and sealing checks; driver completion
alone is not acceptance. The optional standalone visible-range probe is only
diagnostic and never substitutes for these production-helper assertions.
Rich metadata-only checks exercise body omission and policy recovery; they do
not claim metadata-only physical input or zero provider-read instrumentation.

## Isolation And Assertions

The PowerShell fixture compiles a new randomly named WinForms executable.
Every home starts paused with explicit synthetic recording consent, application
and URL defaults set to `do_not_observe`, and only that executable's unique
`win32.<stem>` application ID allowlisted. PowerShell itself is never allowlisted.
All retained events must match the fixture's PID and known HWNDs. Foreground
loss fails acceptance; the policy still denies other applications.

Three independent homes cover:

- Text on: a body-only canary in a normal edit, a same-window edit, two
  same-title HWNDs in one process, and A-to-B-to-A source/focus transitions.
  A pure edit retains its source ID and must not become `window.changed`.
- Long Chinese text and supplementary Unicode characters stay within the
  persisted 28 KiB budget without broken character boundaries.
- The same edit switches from plaintext to password and back; denied text is
  absent and useful capture recovers after the password state is removed.
- Visible password control and an `InPrivate` title: a rising native suppression
  count, a real `snapshot` worker returning `null`, healthy recorder, no new
  retained events, and successful normal-window recovery. The final stream must
  contain neither denied HWND nor body. Worker failure is not clean suppression.
- Pause/resume: actual helper commands, a fresh paused runtime heartbeat with
  unchanged events during a synthetic edit/focus change, then new body evidence.
- A command-controlled UI-thread block first requires the recorder's
  `captureFailures` to rise above zero. While still blocked, a separate worker
  must exit with code 1, no snapshot output, and exactly `uia_capture_timeout`
  or `uia_provider_unavailable` within three seconds. Successful `null`
  suppression, unrelated errors and forced termination do not count. After
  explicit release, new body evidence and a fresh zero-failure runtime sample
  from the same recorder PID prove recovery.
- Text off: useful metadata for two HWNDs, no AX payload or body canary.
- Application exclusion: the same unique application is both allowlisted and
  blocklisted; its real worker returns `null`, recorder suppression must advance,
  and the sealed segment must be empty.
- Each recorder exits on stdin EOF, releases ownership according to native
  status, and seals complete JSONL segments with matching per-segment metadata
  counts. All segments are read in start-time order; event IDs are checked
  within their own segment. Rotation does not require a one-segment assumption.

The recorder is spawned directly by Node with Node's real PID in `--parent-pid`
and an open piped stdin. The harness does not pre-acquire its ownership pipe.
Negative checks wait for native work/heartbeats, not a fixed long sleep. Polling
is every 50 ms; the recorder's existing 3-second sampling and 5-second metadata
flush explain the per-step deadlines. The blocked-recorder assertion allows
20 seconds for the recorder's 15-second idle heartbeat and capture failure.
After release, new body evidence must appear within the normal nine-second
capture deadline. A separate bounded wait requires a health timestamp at or
after that event, because an already-zero failure count publishes every five
seconds. A direct recovery probe does not substitute for recorder evidence.
The fixture polls its release command without pumping UI messages and enforces
a 25-second block cap. The harness releases the block on assertion failure;
stdin EOF also releases it for cleanup. There is a 160-second work budget inside
a 180-second test timeout. Fixture startup has a 15-second compilation limit;
the fixture also exits on stdin EOF, Node parent death, or its 165-second limit.
These are budgets, not a measured Windows runtime guarantee.

## Evidence And Limits

The test diagnostic prints the new run directory's `evidence.jsonl`. It contains
fixture requests and acknowledgements, foreground heartbeats, helper commands
and full stdout/stderr, matched events, assertion outcomes, and exact contents
of every test-home file, including full raw `events.jsonl`, metadata and runtime
on success or failure. The original homes remain beside it. Nothing is uploaded
or automatically deleted. A failed/forced cleanup is never counted as acceptance.

Only inspect or remove that run directory after its owned processes have exited.
Do not use personal windows or type personal content into the synthetic forms.
This exercises native WinForms and title-based private suppression, not browser
document provenance, all password providers, actual private browser modes,
main-process ownership parity, frontend consent, or summary generation. The
existing `computer-history-windows-native.test.mjs` covers ownership/parent-death
smoke tests separately.

On September 15, 2026, run `9eJvzI` passed the complete strengthened matrix on
Windows 11 x64 / Node 24 / MSVC in 96.7 seconds. The recorder reported one capture
failure while the UI thread was blocked. After release, new body evidence
arrived in 5.45 seconds, and fresh zero-failure status from the same recorder
arrived in 7.40 seconds. All three homes sealed and released ownership; cleanup
reported no errors.

Earlier fixed-block acceptance did not prove recorder failure before recovery.
The stronger test exposed a lost retry after epoch invalidation: a separate
worker could read recovered text, but the recorder waited for its idle heartbeat.
The corrected scheduler preserves unsettled work through the normal rate gate.
The test account had High integrity because the lab image disables UAC, despite
the task's Limited run level. This does not establish ordinary-user,
locked-session, or packaged Electron coverage.

Local syntax-only check (does not enable collection):

```sh
node --check apps/desktop/scripts/computer-history-windows-interactive.test.mjs
node --test apps/desktop/scripts/computer-history-windows-interactive.test.mjs
```
