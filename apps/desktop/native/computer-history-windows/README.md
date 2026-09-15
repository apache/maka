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
   and value notifications. The recorder attempts a snapshot at most once
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
Fresh element-scoped caches batch only identity and visibility properties at
each validation boundary; names and values are never prefetched before admission.
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
can include sensitive descendants.

Expected omissions include browser providers without document URLs, unknown
native frameworks, custom/internal browser URLs, cross-process descendants,
elevated applications, rapidly changing trees, and trees that exceed the
complete provenance-check budget. Native document support does not prove that
all versions of Notepad, Word, or terminal applications are covered. UIA failure,
privacy suppression, and stale targets can produce no event. Do not weaken
source checks just to increase event counts.

The September 15 Edge 151.0.4129.93 canary did not pass useful-body acceptance.
The first visible descendant belonged to Edge's separate GPU process; a separate
synthetic-only diagnostic also found no valid source URL on its Document nodes.
The native helper correctly remains closed to these unverified sources, so
browser/password/iframe negative cases are inconclusive, not passing coverage.
Supporting this provider requires explicit cross-process and document-origin
authority, not an address-bar fallback or a broader PID allowlist.

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
and [Edge matrix](../../scripts/computer-history-windows-browser.md) retain
evidence and never access personal history homes.

On September 15, 2026, Windows 11 x64 / Node 24.18.1 / MSVC execution passed:

- All 54 native kernel/store tests and all ten Node/native ownership and shutdown tests.
- Real WinForms body capture, same-title HWND switching, long multilingual text,
  password-state changes, private-title suppression, pause/resume, text-off and
  application exclusion, plus a blocked UI thread followed by capture recovery.
  The strengthened 96.7-second matrix required the recorder itself to report
  failure first, then recovered body in 5.45 seconds and fresh zero-failure
  status from the same recorder in 7.40 seconds after release.
- Accepted JSONL through production evidence projection, summary coordination,
  the existing model connection, Markdown readback and restart without another
  model call, using isolated storage and a single Coproxy Astra request.

The VM account had High integrity even under a Limited scheduled task because
UAC was disabled in the image. Ordinary-user, locked-session and packaged
Electron acceptance remain unverified. Browser provenance must pass a useful
allowed-body baseline before any negative case can count as verified; an empty
result by itself proves neither useful coverage nor privacy protection.
Do not equate this controlled acceptance with production readiness.

## Platform references

- [WinEvent hooks](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)
- [UI Automation threading](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)
- [UI Automation security](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)
- [First-instance named pipes](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea)
- [Windows file identity](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information)
- [Node 24.18.1 bundled libuv pipe implementation](https://github.com/nodejs/node/blob/v24.18.1/deps/uv/src/win/pipe.c)
- [Node 24.18.1 bundled libuv file identity](https://github.com/nodejs/node/blob/v24.18.1/deps/uv/src/win/fs.c)
