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

# Maka Computer History helper

This directory vendors the macOS event-stream collector from
`hqhq1025/open-codex-computer-history` version 0.2.0, pinned to revision
`30c99f904d9375a01e17a05516f896ebda24a544` under its `collector/` directory.

The collector is a clean-room implementation based on public product behavior
and locally observable interfaces. It records Accessibility and Core Graphics
interaction events without screenshots, video, or audio.

Maka owns the Electron integration, process lifecycle, privacy defaults,
timeline projection, and user controls. The vendored collector remains under
the MIT license copied to `apps/desktop/resources/licenses/open-computer-history`.

## Source attribution

The following 13 files contain upstream material and retain MIT attribution,
the pinned source path/revision and a Maka modification notice. They must not
receive a whole-file ASF header or be covered by a blanket directory exemption.
Paths below are relative to this directory; the upstream path is `collector/`
followed by the same relative path.

```text
Package.swift
Sources/HistoryCore/HistoryMaintenance.swift
Sources/HistoryCore/Models.swift
Sources/HistoryCore/Policy.swift
Sources/HistoryCore/RuntimeControl.swift
Sources/HistoryCore/Store.swift
Sources/OpenHistory/AccessibilitySnapshot.swift
Sources/OpenHistory/HistoryRecorder.swift
Sources/OpenHistory/main.swift
Tests/HistoryCoreTests/EventSchemaTests.swift
Tests/HistoryCoreTests/HistoryMaintenanceTests.swift
Tests/HistoryCoreTests/PolicyTests.swift
Tests/HistoryCoreTests/SegmentStoreTests.swift
```

Other source/test files, including `EventPersistence.swift`, `RecorderLifecycle.swift`,
`RecorderOwnership.swift`, `TextInputBuffer.swift`, `ObservationCapture.swift`,
`ObservationDelivery.swift`, `ApplicationIcons.swift` and
their tests, are Maka-authored additions with the repository's standard ASF
header, not part of the vendored source exemption. This README is also Maka-authored.

## Recorder lifecycle

Desktop launches `open-history record --no-prompt --parent-pid <desktop-pid>`.
The parent must be the actual launching process, not PID 1. Standalone callers
may omit the flag to bind to their launching parent. Parent validation and an
exclusive nonblocking `flock` on `recorder.lock` precede permission checks and
segment creation. Duplicate admission exits 75; invalid parent arguments exit 2.
The lock descriptor remains open for the entire recorder lifetime, across
pauses and segment rotation, and closes on process exit. Never unlink this lock
or replace the history home while a recorder is active.

`open-history status` reports `recorderActive` from the lock, independently of
possibly stale `runtime.json`. False means no current lock holder. It never
creates a directory or lock; probe failures exit nonzero instead of reporting
idle. Desktop must not signal a PID read from the status file. Native code uses
a kernel process-exit notification plus direct parent-identity checks before
and after snapshot collection and before persistence. Reparenting prevents new
observations/writes even before the main-queue exit callback executes.

Desktop uses `open-history maintenance --parent-pid <desktop-pid>` before
replacing raw files or collector settings. It first stops its own recorder,
opens `recorder.lock` without following symlinks, and inherits that descriptor
as fd 3. The helper validates the writable descriptor against the exact home
lock inode and acquires the same nonblocking `flock`, without permission checks,
capture, or segment creation. A competing recorder refuses admission with exit
75. Success prints exactly `maintenance-admitted`; Desktop waits for successful
exit before any mutation. The lock belongs to the shared open-file description,
so helper exit/crash does not release Desktop's descriptor. Desktop closes its
descriptor in `finally` after maintenance; process death also releases it.
Failed admission preserves raw files and settings. Never explicitly unlock the
child's duplicate, unlink the lock, or infer admission from an earlier status.

Saved pause is applied before observers start reading. Pause disables the event
tap, removes the AX observer, and discards pending typing, terminal, mouse,
selection and retry work. Stop does the same before finishing storage. Session
boundaries contain only ID, timestamp and kind, including paused startup/stop.
Every observation and persistence entry checks current control state; delayed
callbacks carry a generation that becomes invalid on pause, resume, source
transition or stop. Control requests include an optional unique revision so
pause/resume within one timestamp second cannot revive old work. Older control
files without the revision remain readable.
Event writes fail closed: a partial/failed write poisons that segment, and
subsequent append or seal attempts return the failure. Finalization synchronizes
both event files before atomically publishing ended metadata, then refuses all
further appends. Rotation failure stops the recorder instead of writing into
the sealed old segment. Stop reports `lastError: "storage_failure"` in runtime
status when possible and the helper exits nonzero. If runtime storage is also
unwritable, stderr and the nonzero exit remain authoritative; an old runtime
file is not proof of success. This ordering does not promise power-loss
durability of the directory entry or automatic recovery of partial segments.
Desktop summary admission separately reads saved control, honors unexpired
pauses even with collection disabled, and fails closed on malformed control or
failed native status checks. A stopped runtime is not proof of a resumed pause.

Typing admission checks app/domain/private-window/secure-field policy before
reading event characters. Bursts bind to their original process, window, URL
and focused element; source changes cannot relabel old text. Focus notifications
and rejected/unavailable snapshots discard pending content. A missing URL never
reuses a previous tab's URL. AX metadata acquisition can still read into memory;
the persistence contract below determines what is stored.

Run `swift test --quiet` here and
`npm --workspace @maka/desktop run build:computer-history` from the repository
root. Synthetic tests cover policy transitions, pause/start/stop persistence,
stale callbacks, lifetime lock admission/release, rejected CLI starts and kernel
process-exit notifications using a non-collector child. They do not enable
capture or request permissions. After building, `resources/bin/open-history
permissions --no-prompt` (relative to `apps/desktop`) and `status` are read-only
probes. Real capture and its permission grant remain a separate user action;
Desktop must write `captureText: false` before a metadata-only trial.
Verify the grant through the actual signed Desktop app before starting that
trial. A helper launched from a terminal can report different permissions
because macOS attributes them to its responsible application.

## Application metadata

`open-history applications <bundle-id>...` resolves at most 32 requested local
bundle identifiers, without enumerating or launching applications, starting
capture, reading history, or requesting permissions. It returns only the exact
requested identifier, the installed localized name, and a freshly rasterized
48x48 PNG data URL. An unavailable application uses its exact identifier as its
name and a null icon. Application paths never cross the Desktop bridge.

Desktop bounds each icon to 48 KiB and the complete helper response to 2 MiB,
with a five-second helper timeout. Lookup batches and overlapping IDs coalesce;
the memory-only cache holds at most 256 entries for five minutes on success and
30 seconds for null icons. Renderer callers must filter non-bundle historical
labels before batching. Main rejects malformed requests/responses; it validates
the bounded PNG signature and raster header while the renderer owns image
decoding and the initial fallback for decode failures.

## Text persistence contract

Every `SegmentStore.append` requires the current `ObservationPolicy`. The store
projects the complete `HistoryEvent` before encoding it, including session
boundaries, drag endpoints, selection items, terminal updates and diagnostics.
Producer-side text buffering limits are not the persistence boundary.

With `captureText: false`, persisted events retain IDs, timestamps, interaction
kinds, application metadata, window titles, HTTP(S) URL scheme and domain,
mouse button/count/modifiers, keyboard modifiers, AX role/subrole and numeric
selection ranges. URL credentials, port, path, query and fragment are removed;
invalid and non-web URLs are omitted.

Typed and selected text, key equivalents (which can contain typed characters),
control values, element titles/descriptions/placeholders/identifiers, AX full
trees/diffs and diagnostic messages are omitted. Document UI labels and selected
item names can contain document content, so they are treated as text too.
Application names, window titles and domains remain potentially sensitive
metadata by explicit contract. This setting is not anonymization or a promise
that no text is read into memory. It affects new writes, not existing history.

With `captureText: true`, ordinary event content is retained. Application/domain
blocks, detected private browsing, secure-input flags and secure element
roles/subroles still suppress events, including either endpoint of a drag and
selected items. Session boundaries in suppressed contexts retain only ID, time
and kind. Suppressed events are counted; even when the optional debug
`suppressed.jsonl` is enabled it contains only those three fields.

New content-bearing events carry an opaque window-lifetime `sourceId`,
`contentState: available`, and `contentDomains` naming every contributing
admitted web document, including embedded frames. Non-web documents use an empty
domain list. Unknown ownership produces metadata only, without borrowing a URL
from a link or another window. Denied source contexts suppress the event.
Capture uses the owning AX document and rechecks source, security, and domain
after blocking AX reads. A detached, changed, or denied subtree contributes no
text. Native source identities are hashed again before model projection.

Non-browser applications may contribute explicit local `file:` WebAreas
(empty host or `localhost`). The verified `app:` WebArea scheme is admitted
only for the Codex bundle. The exact local document identity is kept in memory
for revalidation and typing attribution, never persisted as a window URL.
HTTP(S) descendants still require admitted domains; local/custom documents
nested beneath a remote WebArea cannot inherit native-app authority. Missing
URLs, unsupported schemes, and remote file hosts remain unavailable.

AX trees are self-contained bounded snapshots (32 KiB, 256 nodes, depth 14),
not deltas requiring an unavailable baseline. The decoder retains support for
older deltas, but Desktop never sends those deltas to the analysis model.
Admitted leaf values retain up to 8 KiB, including read-only document bodies
outside the focused control; other leaf attributes retain up to 400 bytes.
Attribute clipping sets `truncated` and preserves UTF-8 boundaries. These
per-attribute limits do not expand the tree's total byte or traversal budgets.
For admitted leaf `AXTextArea` controls supporting `AXVisibleCharacterRange`,
the collector requests `AXStringForRange` with at most 8192 UTF-16 code units
and retains at most 8 KiB of UTF-8. Scrolled document tails can therefore
contribute without fetching the entire value. Incomplete edge surrogate pairs
are omitted, malformed interior UTF-16 is rejected, and the visible range is
rechecked before final source/security validation. Ranged samples set
`truncated`, since they do not claim the complete document. Only an explicitly
unsupported visible-range attribute uses the existing value-prefix path;
failed or changing range reads never fall back to unrestricted values.
The serialized byte budget includes JSON escaping; an oversized attribute
retains a valid JSON-encoded prefix instead of dropping its entire leaf.
With text enabled the producer omits secure nodes and descendants before
rendering. Private-window detection depends on
the supported browser bundle IDs and title markers, and secure detection depends
on the AX flags/roles supplied by the application. Unmarked secrets in ordinary
document content cannot be identified by this policy.

An empty children array can make the ranged AX API return `illegalArgument`.
Only a successful zero child count resolves that case to a leaf; messaging
errors remain unreadable. Cancelling pending sensitive content preserves
retained metadata deduplication, so an unavailable snapshot does not create
a new identical window-change event every three seconds. Control focus changes
also cancel stale input and callbacks without resetting persisted window
identity; actual source/window changes still produce a window-change event.
Generic AX notifications coalesce by pending foreground window before full
traversal, with a first-event 200 ms debounce and at most one scheduled attempt
per three seconds. Selection retains its exact notification origin, while
typing, clicks and shortcuts retain their separately validated semantic paths.
A full snapshot defers the fallback by three seconds; this retains timely
capture for providers that do not emit usable change notifications. Cancellation never marks
dirty work as successfully captured, and continuous events cannot postpone the
first dirty deadline indefinitely. No sensitive snapshot is reused across
capture attempts.
Window identity combines AX equality with the kernel PID/start time, validated
before and after capture. It does not depend on LaunchServices `launchDate`,
which may be absent for directly launched apps. Reading the owned application's
AX role before its focus lets Chromium initialize native accessibility on cold
startup; the collector does not write accessibility-mode attributes.

Local persistence and model transmission are independent permissions. Desktop's
`summaryTextEnabled` setting defaults off and is not a native capture permission.
Only the main-process evidence projector may send admitted recorded text to the
analysis provider. It rechecks current source exclusions and requires the new
content/source/domain markers, so legacy unclassified content is not upgraded
merely by enabling text analysis.

Run `swift test` here for synthetic persistence tests. The tests do not start the
collector or request Accessibility/Input Monitoring permissions.
