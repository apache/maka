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
- The current foreground window on the input desktop named `Default`.
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
3. A short-lived `snapshot` worker binds to one exact HWND and PID and reads
   UI Automation on a dedicated MTA thread. It checks foreground identity,
   source provenance, sensitive controls, and observation policy.
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

App IDs use `win32.<lowercase executable stem>`, for example `win32.notepad`.
Names currently use the stem; native icons and localized application names are
not part of this backend change. Source UUIDs distinguish foreground generations;
they are not durable document IDs across focus changes or process restarts.
`window.changed`, `ui.changed`, and `selection.changed` describe observed UI
changes. They must not be interpreted as proof of a keystroke or submission.
There are no screenshots, audio, low-level keyboard hooks, or typed-text events.

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

On September 15, 2026, Windows 11 x64 / Node 24.18.1 / MSVC execution passed:

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
