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

# Windows Computer History backend

This draft Windows x64 helper produces the same bounded JSONL event envelope as
the macOS collector. Electron main remains the authority for settings, storage
maintenance, 48-hour retention, evidence projection, Markdown summaries, and
model connections. There is no separate Windows provider or history database.
See [the integration contract](../../../../docs/computer-history-integration.md).

## Supported environment

- Windows x64, a local interactive user session, and a local NTFS history home.
- The current foreground window on the input desktop named `Default`, in a
  WTS-connected and unlocked session. Unknown session state fails closed.
- Ordinary user privileges. The helper does not request elevation or UIAccess,
  bypass secure desktops, or change browser accessibility settings.
- History directories and their ancestors must not be symlinks, junctions, or
  other reparse points. Network paths, FAT, and ReFS are outside this contract.
- Packaging is native Windows x64 with Rust 1.92 or later and the MSVC toolchain.
  Cross-checking from another OS does not produce a runnable, validated release.

`permissions --no-prompt` and `status` report
`permissionModel: "interactive-session"`. Their legacy `accessibility` and
`inputMonitoring` booleans describe session readiness, not macOS TCC grants.
They do not establish that every application exposes readable UIA content.
Centralized macOS permission prompts are not reused or simulated on Windows.

## Capture and data flow

1. `record --no-prompt --parent-pid <pid>` validates its actual launching parent,
   acquires exclusive ownership, and reads explicit recording consent.
2. Out-of-context WinEvent hooks coalesce foreground, focus, selection, name,
   value, tree-reorder and IAccessible2 document/text notifications. These
   notifications invalidate observations; they contain no captured text.
   The recorder attempts a snapshot at most once
   every three seconds, with a fifteen-second heartbeat and failure backoff.
3. An adaptive `snapshot-lease` worker binds to one exact HWND and PID and reads
   UI Automation on its owning MTA thread. It prepares any required WPF/Chrome
   input subscriptions before its single body traversal, then checks foreground
   identity, source provenance, sensitive controls, and observation policy.
   The public `snapshot` command remains available for standalone observations.
4. The supervisor rechecks admission and applies the current persistence policy
   before writing an event. Successful snapshots are self-contained;
   `ax.mode: "fullTree"` means a bounded text snapshot, not an XML UI tree.
5. Ten-minute raw segments feed the existing main-process summary pipeline.
   Raw events never enter a new renderer or model-facing transport.

Snapshots are bounded to 256 nodes, depth 14, and 32 KiB before persistence;
the event text budget is 28 KiB. Traversal has a 700 ms cooperative budget.
The supervisor kills workers after two seconds, and each worker independently
watches its parent, consent, and deadline so blocked COM calls cannot keep an
orphan alive indefinitely. UIA connection and transaction timeouts are 250 ms.
Fresh element-scoped caches batch identity and visibility properties at
each validation boundary, plus type/framework where consumed together. The
frequent sensitive-read visibility checks retain their narrower request;
names and values are never prefetched before admission.
Invalidating an in-flight capture preserves its unsettled generation for a fresh
attempt through the existing three-second rate gate and fifteen-second failure
backoff. A completed observation is settled, so unrelated idle destruction does
not itself schedule new work. Only destruction of the retained source HWND
rotates window identity; other destruction still invalidates pending content.
Health is published on state/failure changes and at least every five seconds.
Repeated provider/transport failures and stale running heartbeats surface through
the existing status error field; admitted privacy suppression is not a provider
failure. Recovery clears this error without restarting the recorder.
Pause, lock and disconnect cancel pending work and seal the active segment
before publishing paused health. A sent session notification also invalidates
the source generation, retaining a suspension boundary even when reconnect
occurs between polls. Resume creates a fresh segment without opening repeated
empty segments during suspension.

Executable IDs use `win32.<lowercase executable stem>`, for example `win32.notepad`.
Packaged processes additionally carry the exact process AUMID, rechecked on the
same held process handle. Shared history uses `winapp.<AUMID>` for grouping and
search; either packaged or executable exclusion suppresses the source.
Event names use the stem. `applications <id>...` independently resolves metadata
for up to 32 canonical Windows IDs, returning an ordered JSON array of
`{ bundleIdentifier, name, iconDataUrl, resolution }`, where resolution is
`resolved`, `registered`, `not_running`, or `unavailable`. It requires no History environment,
consent or storage. For a uniquely located running executable on a local drive,
it reads FileDescription and extracts a 48-by-48 RGBA PNG, bounded to 48 KiB.
For an absent process, it checks only the requested executable's exact App Paths
default value in HKCU and HKLM, using their canonical 64-bit views. Conflicting,
malformed, nonlocal, stale, or reparse-point registrations are rejected.
`registered` describes the currently registered executable, not the historical
producer, and never seeds extended closed-session metadata retention. There is
no application discovery scan or registration launch. An exact packaged ID uses
the current AppInfo registration, with package identity/version revalidation
and bounded logo decoding. Its `registered` result is current metadata, not
proof of a historical producer or permission to retain a closed-session icon.
Unknown or ambiguous IDs return their original ID and a null icon.
Source UUIDs distinguish foreground generations;
they are not durable document IDs across focus changes or process restarts.
`window.changed`, `ui.changed`, and `selection.changed` describe observed UI
changes. They must not be interpreted as proof of a keystroke or submission.
There are no screenshots, audio, or typed-text events. While recording is
admitted, bounded passive keyboard/mouse hooks retain Return, modified virtual
keys and same-control down/up facts only for an already admitted native
Win32/WinForms Edit or RichEdit child. Standard Edit requires the actual UIA
Edit type and emits an `AXTextField` target. CUIAutomation8 exposes the tested
WinForms RichEdit20W as a Document, mapped to `AXDocument`; legacy UIA may expose
the same HWND as Pane, mapped to `AXGroup`. Exact native class, current focused
HWND/PID/root, visible-leaf, framework and password checks remain required.
The RichEdit Document ValuePattern contains own text rather than a URL.
Its narrow native source never reads that value or a selection. Independently
validated, explicitly nonhidden visible TextPattern runs can contribute partial
body text as described below. This source does not authorize other Documents
or Panes.
Injected input, AltGr composition and unmodified
typing are not retained. The callback verifies the original focused child;
mouse facts additionally require that child at the pointer location.
For these native Edit controls, the callback also rejects `ES_PASSWORD` and
failed window-style reads. Injected mouse input interrupts pending physical
down/up pairing instead of disappearing between two apparent click endpoints.
These receipt-time checks do not prove that no protected-state transition
occurred and reverted between observations.
`keyboard.submit` means a Return key fact, never a successful submission.
`keyboard.shortcut`, `mouse.click`, `mouse.contextMenu`, and `mouse.drag` do not
claim the requested command succeeded. These action records contain no body
or selection snapshot. A separate observation records any resulting UI text.
An observed same-control press excursion produces a drag fact with matching
source-only origin/destination, including out-and-back movement. It does not
persist the pointer trajectory. Ordinary movement preserves unrelated keys;
source uncertainty, injection and expired admissions still clear all facts.
That native-child path does not authorize browser DOM, WPF or WinUI targets.
A separate `snapshot-lease` mode in the existing disposable child can admit
observed WPF and Chrome keyboard targets. The same MTA owns UIA subscriptions
and captures; each source retains the exact element and owning-document runtime
IDs plus the real native focus host. Metadata-only notifications invalidate
identity or content without reading provider values in callbacks. The parent
checks the live lease and fresh source before draining or writing actions.
One-shot snapshots cannot authorize this mode, and runtime IDs never enter
retained events. The recorder starts the adaptive worker directly; there is no
second cold-start upgrade or repeated initial body traversal. Subscription
preparation consumes the original 700-ms capture and two-second operation
budgets. Native and body-only outcomes produce one initial terminal frame.
The parent accepts it only after clean EOF, successful child exit and fresh
source, policy and lifecycle checks. Such a terminal frame cannot grant
external UIA input authority. Subscription setup failure counts toward health
and backoff even when safe body is retained or no snapshot is available.
External cancellation still takes precedence.
A completed content-only cancellation can retain the same child, but cannot
renew source or action deadlines. Worker termination immediately closes input
admission without fabricating a source-change notification. Its first terminal
reason and time distinguish expected expiry or actual external cancellation
from provider failure, including failure observed before a later expiry.
Keep, retire and terminal disposition share the existing lease mutex. Terminal
classification retains the child owner while rechecking external authority;
health is published once afterward, so late EOF cannot silently lose failure
backoff. This path remains subject to actual recorder acceptance;
subscription API availability does not establish provider coverage.
The same worker also supports observation-only item selections. A validated
selection owner under the captured root can retain an empty or nonempty
selection without an input target. SelectionItem and Name notifications
invalidate content; renewal preserves the original two-second operation and
five-second lease limits. The retained baseline contains only source, owner
and document identity, not labels or prior membership. Changed ownership
requires a fresh capture. Observation acceptance never admits physical input
or upgrades the lease to input authority. Missing optional selection capability
still permits a separately validated body-only terminal snapshot.
WinUI/XAML input, typed characters, IME composition, generic UIA mouse targets
and cross-control gestures remain unsupported.
Text-disabled action records retain action kind, modifiers and role, but no
key equivalent, target text, body, selection text or native target identifier.
Either text-policy transition invalidates pending actions before new admission.
Input scopes require current source/focus epochs, consent and a bounded-age
admitted snapshot. A fresh worker verifies the same target/source before
persistence. Timeout, provider failure, suppression and lifecycle transitions
revoke queued input; an admitted same-source content-only retry may retain it.
An admitted UIA source renews only after a newer verifier passes exact
same-source, configuration, policy and final admission checks before the
previous deadline. Freshness is five seconds from verifier start, never response
arrival. A parsed frame alone cannot admit input. Worker liveness has its own
same-source renewal and cannot confer recorder authority; worker birth and the
two-second operation watchdog remain independent. Idle time, notices, requests,
null output and failures do not renew either authority. Expired workers cannot
be revived.
Refresh normally follows the three-second rate gate. For a live UIA source,
one early attempt reserves the two-second operation budget and two existing
50-ms polling turns before expiry. Provider failures retain normal backoff.
Renewal never extends an already observed action's original age.
The retained input source omits body, text/item selection and action content once, while
the existing 50-ms policy reload and source admission checks remain unchanged.
Native clipping provenance is retained in `ax.truncated`, even when the final
event projection does not clip again. Optional `selection.selectedText` is
bounded to 8 KiB, preserves whitespace and includes `truncated` plus a UTF-16
`start` offset. When the original length is available, the event instead uses
`selection.selectedRange` with UTF-16 `location` and `length`.
Text and item selection changes participate in deduplication and event kind.
Text-disabled policy removes body and selected text, retaining independently
observed numeric ranges for supported standard Edit controls. Body and selected
text plus encoded selected items share the existing 28-KiB event-text limit.

## Privacy and coverage

Recording, local text capture, model summaries, and text transmission retain
their existing independent controls. Windows does not turn any of them on
implicitly. Policy read failures stop admission rather than use a permissive
default. Every persistence operation applies the latest policy supplied by the
supervisor, including app/domain exclusions and removal of locally disabled text.

Visible password controls suppress the snapshot including its title. Offscreen
subtrees are omitted. Known credential applications and private-window title
markers are excluded. Private browsing detection is conservative and heuristic:
an ordinary title containing "private" can be suppressed, and application
providers must not be assumed to expose all privacy state reliably.

A web Document must expose its own valid URL. An address bar, a title, or a
hyperlink cannot establish a document's domain. All observed document domains
must be admitted; URLs persisted to history contain no credentials, path,
query, or fragment. A URL-less Document can be treated as native only for an
explicit Win32, WinForm, or WPF provider outside browser/web context. Bounded
TextPattern reads are limited to childless native Documents; parent text ranges
can include sensitive descendants. WPF `TextBox` controls may contain
ScrollViewer template children while owning a scalar ValuePattern. That value
is read only after the complete native window passes validation, with fresh
control/ancestry checks and a second whole-tree check afterward. This does not
authorize aggregate text from arbitrary parent controls.
Admitted native leaf Documents/Edits and the validated WPF TextBox own-text
path prefer `TextPattern.GetVisibleRanges` over the document prefix when
supported. At most 16 spans share the existing byte and time budgets. Every
range must belong to the admitted control; visible endpoints, ownership and
the tree are checked again before returning the snapshot. A successful empty
or degenerate range stays empty. Explicitly unsupported TextPattern or
GetVisibleRanges discovery retains the previous admitted body path; failures
after ranges are obtained reject capture, without whole-document fallback.
Viewport samples set `ax.truncated` because they
are partial document evidence. This does not enable browser/container ranges.
Childless, admitted Win32/WinForm RichEdit Documents use a separate bounded
visible-run path. Each noncollapsed run must remain inside its visible range,
belong to the exact source element and report `IsHidden` as explicit boolean
false before and after reading. A forward search for hidden text delimits each
candidate prefix; a successful null match still requires explicit nonhidden
admission of the entire candidate. This avoids making reads and retained
witnesses depend on how a provider fragments nonhidden attribute matches.
Hidden delimiters are never read. Their ownership, containment and hidden
attribute are rechecked before advancing an independent cursor, whose endpoint
equality and strict progress are verified. The reader admits at most eight visible
ranges, sixteen search iterations (including hidden-only skips), sixteen runs
and 8 KiB of body per leaf, with at most 8193 UTF-16 units
of retained comparison text. A contained collapsed search result stops
enumeration without reading or advancing the unchecked tail. Final checks
revalidate native ownership, text equality, visible endpoints, tree, policy
and source epochs. Partial samples always set `ax.truncated`, even if they fit.
Visible unfocused siblings are independently eligible for body capture;
input admission still requires the original focused target. Text-disabled
capture performs no Rich body reads. Unsupported optional pattern discovery
preserves metadata without any whole-body, ValuePattern or selection fallback.
Unknown/hidden attributes, escaped ranges and failed final reads reject capture.
Selection ranges require a fully observed visible source-admitted subtree,
stable focus/range endpoints, and final tree checks. Multi-range selections,
hidden/wrapper descendants and offsets beyond 32 Ki UTF-16 units are omitted.
Explicit unsupported/not-implemented optional selection operations and successful
null focus/range interfaces omit selection, after fresh tree validation, without
discarding permitted body text. Provider loss, timeout, and privacy/identity
failures still reject the capture.
For standard native leaf Edit controls, `EM_GETSEL` reads its two full DWORD
outputs, not the packed return value that loses offsets above 65535. Collapsed
selections and ranges beyond the text-read limit retain their numeric location
and length without a body read. With text disabled this is the only selection
path; general UIA providers cannot derive offsets by reading a document prefix.
With text enabled and no TextPattern,
bounded offsets slice the admitted scalar ValuePattern. Some Win32
UIA proxies clip that scalar at 4096 UTF-16 units. When it cannot cover the
selection, the reader uses bounded `WM_GETTEXT` for the exact admitted native
Edit. The same reader supplies standard Edit body text after the complete tree
passes validation, so unselected document tails are not lost to this proxy cap.
This path does not admit unknown containers, browser controls or WPF parent
values. It preserves fresh UIA HWND, native class/PID/root/focus/password-style
checks before and after, plus final whole-tree checks. Selection retains the
8-KiB UTF-8 limit; offsets beyond 32 Ki UTF-16 units omit selected text while
retaining the numeric range. A failed or short replacement cannot reuse the
clipped scalar.

`WM_GETTEXT` is a system message, so Windows marshals its bounded local buffer.
The capacity includes the terminator; the returned count excludes it. The
separate worker uses `SendMessageTimeoutW` with 100 ms inside the unchanged
capture deadline. No custom-message pointers or clipboard reads are used.
The standard Edit fallback is not applied to RichEdit, whose formatted content
can include hidden runs. The unpatterned RichEdit Pane's body remains unavailable.
Microsoft contracts:
[WM_GETTEXT](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-gettext)
and [SendMessageTimeoutW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw).

For known browsers, the reader selects the outermost Document on the focused
element's verified ancestry to the exact foreground UIA window. Its bounded
body traversal excludes browser chrome, including GPU-owned panes. Every
visited visible element must still report the selected PID. Sensitive reads
recheck the window root and document ancestry; final validation also checks
focus, observed tree structure and each document's original URL.

Chromium accessibility can initialize asynchronously after ordinary UIA queries.
If no focused Document exists yet, the reader can query nonsensitive properties
of a single visible, same-PID `Chrome_RenderWidgetHostHWND` under the selected
window. It captures no names, values or source URLs during that preparation;
a later worker must independently admit the populated document. No browser
flags or accessibility/security settings are changed. Ambiguous content hosts
remain unsupported.

A Chromium iframe may expose a URL-less Document wrapper around one real
Document. Only an absent ValuePattern, one visible same-PID Chrome Document
child and the child's own valid remote URL permit that structural wrapper.
It contributes no text or inherited source authority. The child undergoes the
normal domain checks, and final validation pins the observed wrapper/child
relationship. Empty or malformed URL patterns are not wrappers.

Expected omissions include browser providers without document URLs, unknown
native frameworks, custom/internal browser URLs, cross-process descendants,
elevated applications, browser-toolbar focus without a focused Document,
rapidly changing trees, and trees that exceed the
complete provenance-check budget. Native document support does not prove that
all versions of Notepad, Word, or terminal applications are covered. UIA failure,
privacy suppression, and stale targets can produce no event. Do not weaken
source checks just to increase event counts.

The September 15 Edge `151.0.4129.93` canary passed useful-body acceptance after
focused-document traversal and asynchronous initialization were implemented.
Earlier whole-window traversal rejected a GPU-owned pane before reaching the
document, and a first diagnostic query saw only empty initial URLs. A retained
native client subsequently exposed the actual document URL after 900 ms.
This is measured support for this Edge configuration, not proof of all
Chromium, Firefox, Electron or WebView2 providers. No cross-process allowlist
or address-bar fallback was added.

## Ownership and shutdown

The recorder retains its parent's process handle and validates creation time
to reject PID reuse. Electron requests graceful shutdown by closing piped stdin;
parent death also closes that pipe. Paused recording removes event hooks and
cancels pending workers. Explicit disablement is checked again at native startup.
On Windows main spawns the recorder detached from libuv's kill-on-close job,
while retaining its ChildProcess and piped stdin. This gives the native parent
watchdog time to seal the store after main exits; it is not an unowned daemon.
Final teardown attempts input-thread shutdown, segment sealing and runtime
publication independently. A failed input shutdown cannot skip sealing.
The first error is retained; runtime reports `error` instead of successful
`stopped` when capture or an earlier cleanup step failed.

Storage admission is a first-instance named pipe:
`\\.\pipe\maka-history-<volume-serial-hex>-<file-index-hex>`.
Node's bigint `stat.dev` and `stat.ino` match the native NTFS volume serial and
64-bit file index. Both sides use lowercase, unpadded hexadecimal.
The pipe transports no data. It provides single-writer exclusion, not an
authorization boundary.

During delete, clear, or retention work, Electron main owns the kernel pipe
directly until the operation finishes. A disposable helper cannot own this
lock on main's behalf. The home directory must retain its identity throughout
maintenance. Main invokes the native `validate-home` command before and after
acquiring ownership to check local storage and reparse-point constraints that
Node alone cannot verify. Status probes are read-only and momentary; starting a recorder
must acquire ownership again. Occupied admission exits with code 75.

## Build and verification

From the repository root on Windows x64:

```sh
cargo fmt --manifest-path apps/desktop/native/computer-history-windows/Cargo.toml --check
cargo clippy --manifest-path apps/desktop/native/computer-history-windows/Cargo.toml --locked --all-targets --target x86_64-pc-windows-msvc -- -D warnings
cargo test --manifest-path apps/desktop/native/computer-history-windows/Cargo.toml --locked --all-targets --target x86_64-pc-windows-msvc
node --test apps/desktop/scripts/build-computer-history-helper.test.mjs
node apps/desktop/scripts/build-computer-history-helper.mjs
node --test apps/desktop/scripts/computer-history-windows-native.test.mjs
```

The Windows workflow builds `resources/bin/open-history.exe`, validates its
PE architecture, and checks native/Node ownership against the actual helper.
Tests use independent temporary homes and synthetic data, never personal
recording settings. Pure policy, source parsing, and store tests can also run
on macOS or Linux; kernel and process tests require Windows and must be reported
as skipped elsewhere.

Live acceptance uses isolated interactive Windows test desktops and synthetic
content. The opt-in [WinForms matrix](../../scripts/computer-history-windows-interactive.md)
and [Edge matrix](../../scripts/computer-history-windows-browser.md), plus the
[WPF matrix](../../scripts/computer-history-windows-wpf.md), retain
evidence and never access personal history homes.

Earlier September 15, 2026 validation on Windows 11 x64 / Node 24.18.1 /
MSVC passed the following baseline (not the final input/visible-range revision):

- All 54 native kernel/store tests and all ten Node/native ownership and shutdown tests.
- Real WinForms body capture, same-title HWND switching, long multilingual text,
  password-state changes, private-title suppression, pause/resume, text-off and
  application exclusion, plus a blocked UI thread followed by capture recovery.
  The strengthened 96.7-second matrix required the recorder itself to report
  failure first, then recovered body in 5.45 seconds and fresh zero-failure
  status from the same recorder in 7.40 seconds after release.
- All eleven Edge cases, including real body/origin, navigation, matched
  password/title suppression and recovery, blocked top-level/iframe domains,
  real fresh-profile InPrivate, text-off/on and cold recorder startup.
  Run `eazkDX` observed the unchanged cold page in 3.51 seconds and an in-place
  edit in 3.58 seconds with the same source UUID. Before document/text event
  subscriptions, the edit waited 15.58 seconds for the idle heartbeat.
  A later iframe baseline timeout led to fresh metadata-read batching;
  final `xj9Teh` passed the stronger DOM iframe-focus/blocked-parent sequence
  and recorder sealing checks in 44.01 seconds. The cold body/edit times were
  3.53/3.61 seconds. Detailed failed and successful samples remain in the
  Edge matrix documentation.
- All five WPF cases, including TextBox and RichTextBox body edits, an unfocused
  PasswordBox sibling, text-off/on and app block/unblock. After metadata-read
  batching, WPF `4frkEO` passed all five cases again in 32.86 seconds and the
  full WinForms `6WiP4E` recorder regression passed in 91.14 seconds.
- Accepted JSONL through production evidence projection, summary coordination,
  the existing model connection, Markdown readback and restart without another
  model call, using isolated storage and a single Coproxy Astra request.

The VM account had High integrity even under a Limited scheduled task because
UAC was disabled in the image. Ordinary-user, locked-session and packaged
Electron acceptance remain unverified. Browser provenance must pass a useful
allowed-body baseline before any negative case can count as verified; an empty
result by itself proves neither useful coverage nor privacy protection.
Do not equate this controlled acceptance with production readiness.
The Windows workflow also runs deterministic receipt, sealed-action ledger and
cleanup tests with all three foreground-suite opt-ins explicitly disabled.
Those checks launch no recorder or fixture. Foreground results still require
the dedicated interactive procedures above.
Newly staged executables also showed approximately 24 seconds of first-launch
delay before native entry, separately measured by the harness's initial
`status` call. The cause is not established; it is not UIA traversal latency
and remains a first-run/packaging acceptance gap.

## Platform references

- [WinEvent hooks](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)
- [UI Automation threading](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)
- [UI Automation security](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)
- [First-instance named pipes](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea)
- [Windows file identity](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information)
- [Node 24.18.1 bundled libuv pipe implementation](https://github.com/nodejs/node/blob/v24.18.1/deps/uv/src/win/pipe.c)
- [Node 24.18.1 bundled libuv file identity](https://github.com/nodejs/node/blob/v24.18.1/deps/uv/src/win/fs.c)
