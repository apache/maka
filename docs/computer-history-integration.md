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

# Computer History integration

## Product decision

Maka treats Computer History as a user-controlled source of recent computer
activity. It records interaction metadata and produces optional text summaries.
It does not record screenshots, video, or audio.

The integration has five boundaries:

1. A macOS helper records Accessibility and Core Graphics interaction events.
2. The Electron main process owns the helper lifecycle, raw files, privacy
   settings, retention, deletion, and timeline projection.
3. The preload bridge exposes bounded status, controls, and reduced timeline
   entries. It never exposes raw JSONL paths or event bodies.
4. The local Runtime Host executes optional analysis using its existing Daily
   Review model authority, without tools. Collection and model processing require
   separate consent. Model summaries are written locally by the main process.
5. The user selects history to include in an editable conversation draft.
   Observation-derived content is not automatically promoted to trusted
   long-term preferences or sent as a chat message.

This follows the released Computer History generation: an interaction-event
stream, not the older screenshot/OCR Chronicle design.

## User experience

The selected navigation direction is a global left-sidebar entry opening an
independent Computer History page. It is not scoped to the active task or the
selected remote Host. It replaces the former Workbar integration.

The page opens as a full-width chronological feed grouped by local date.
Selecting an activity opens a side-by-side reader; closing it restores the
feed. On narrow screens the reader replaces the feed and has a back action.
List rows
show time, title, a short summary, and native application icons. The detail
surface shows the title, description, interval, contributing applications, and
the complete saved Markdown body. Rendered Markdown is the default, with
headings, lists, tables, quotations, and syntax-highlighted code blocks. A source
mode shows the complete serialization, including frontmatter. Reading the
document requires no file-manager handoff. Observed links remain inert text and
images render only their alt text, preventing commands or network requests on
selection. Recorded events and source windows stay collapsed until requested.
The history page includes:

- recording state, pause/resume, and refresh;
- search, date, and application filters over activity summaries;
- a gear opening Settings > Computer History directly;
- per-activity deletion with confirmation;
- explicit selection of one activity for an editable chat draft;
- user-reviewed workflow suggestions.

Settings > Computer History owns recording enablement, separate text and model
consent, macOS permissions, application/domain exclusions, retention information,
and scoped history deletion. It uses the existing settings navigation instead
of a second settings panel inside the feed. Returning keeps the selected
activity, filters, scroll position, and keyboard focus, and refreshes the local
recording status. Pause/resume also preserves the open document.

Settings reads status and analysis-model configuration independently. An
unreadable archive does not prevent disabling collection or clearing data.
Recent-application discovery is an optional bounded timeline read, independent
of settings health. Model configuration explicitly selects the local Runtime
Host before opening Daily Review settings; a remote task target cannot redirect
Computer History's model authority. An empty analysis model key resolves through
that local Host's canonical default model, matching execution admission; catalog
failures remain errors rather than appearing as missing configuration. History
viewing does not read model settings.

Application names and icons are resolved locally from bundle identifiers using
Launch Services and `NSWorkspace`. The helper returns a 48px PNG, never the
application path. The main process validates and caches bounded batches; the
renderer displays 20px list icons and 24px detail icons with a name-initial
fallback for missing or unreadable images. This requires no capture permission,
application launch, network icon service, or bundled third-party brand assets.
The settings exclusions picker shows names and icons from retained history,
with a Bundle ID input for sources absent from that list. Exclusions change
future collection policy without deleting previously retained evidence.

The page uses Module Hub's services and draft ownership. Adding a draft
selects the local target, preserves existing Composer text, and never sends a
message. The detail API returns at most 100 privacy-reduced event projections,
with retained counts and an explicit expired-evidence state.

## Privacy defaults

- The feature is disabled by default.
- Typed-text persistence is disabled by default.
- Model processing is separately disabled by default.
- Secure input flags and secure element roles suppress affected events.
- Detected private-browsing contexts are suppressed.
- Keychain Access is blocked by default.
- The helper does not request Screen Recording and does not capture screenshots,
  video, or audio.
- Reads exclude events older than 48 hours from projections and analysis.
  Physical cleanup runs at startup and every ten minutes while Desktop is open,
  independently of collection and model consent. It uses event timestamps,
  stops the recorder before replacing active files, and re-reads its final
  buffered writes. Cleanup after an application shutdown resumes at next
  startup; summaries persist until cleared.
- Suppressed event bodies are not stored; only a count is retained.
- Renderer and model-facing projections omit keyboard text, selection text,
  accessibility values, raw paths, and process identifiers.

The persistence boundary projects every native event, including nested drag
endpoints and selection targets. With text capture off, it removes text-bearing
AX fields, keyboard values, diagnostics, and URL credentials/path/query/fragment.
Window titles and app names remain metadata and can themselves contain sensitive
text; this option does not anonymize activity or scrub existing files. The
native README defines the complete write contract.

Window titles and app names are observed external data. Before they can enter
the Composer, control characters and tag delimiters are escaped and the
projection is wrapped in an `untrusted-observed-ui` envelope that explicitly
instructs the model to treat the contents as data rather than commands.
Summaries retain this untrusted status. Enabling model processing sends bounded
application, window, interaction, and prior-summary evidence to the configured
model provider and consumes model tokens; it is not wholly local processing.

## Summary lifecycle

The main process schedules closed UTC ten-minute windows and six-hour rollups.
Each pass processes at most six items, using a 48-hour raw evidence horizon.
Persisted deterministic identities prevent regeneration across restarts.
Six-hour summaries derive from the available ten-minute summaries; they do not
assert that every moment of the interval was observed.

Markdown summary files contain versioned JSON frontmatter, bounded model
content, and application/source identifiers computed outside the model.
The model cannot choose filesystem paths. Clear and shutdown abort in-flight
analysis and fence late output before persistence.

Summary details include a document named `<summary-id>.md`, its canonical
serialization including JSON frontmatter, and the validated, unescaped Markdown
body. Storage and detail projection share one serializer. Raw entries have no
document. The body is bounded to 8 KiB and the serialized file to 128 KiB; readers
must render it as untrusted Markdown. This does not alter the escaped Composer
context or the existing 30-day detail lookup. Summary application identities
prefer native bundle IDs, with name-only fallbacks when no ID was observed.

Pause, disable, clear, and shutdown initiate collector control without waiting
for model cancellation to settle. Full clear deletes owned summary files without
requiring them to decode successfully. Summary deletion failures do not prevent
independent raw cleanup and are still reported to the caller. Partial raw clear
drops malformed records whose timestamps cannot establish that they are outside
the selected interval.

Storage maintenance stops the owned recorder and requires native lock admission
before deletion, retention, or configuration writes. The helper acquires the
lock through an inherited descriptor; main retains that descriptor for the
complete operation, including after the helper exits. A foreign recorder or
maintenance owner prevents admission. Persisted pause remains authoritative
across helper restarts and collection disablement, and failed or malformed
native status blocks model admission.

The Runtime Host validates request/result bounds, checks incognito policy,
executes with no tools, and meters calls under `computer_history`. Requests
use the local Host even when the selected conversation runs remotely.
Summary cancellation is opt-in and bound to the transport request ID on its
originating connection. Aborting queued work removes it before dispatch;
dispatched work uses an out-of-band `request.cancel` control frame, following
the existing Client Capability control-frame path. A separate cancellation RPC
in the domain queue cannot uphold consent revocation: under saturation it can
expire while the summary remains queued and later sends evidence.

The Host registers cancellation before asynchronous admission checks and
reclaims its state when that request ends. Unknown or completed IDs create no
state. Other operations retain their existing behavior. The summary promise
waits for the terminal Host response unless its original timeout or connection
failure intervenes; a client timeout alone does not prove the provider stopped.
Cancellation cannot retract evidence already transmitted to a provider.

## Implementation map

- Shared contract: `packages/core/src/computer-history.ts`
- Native collector: `apps/desktop/native/computer-history`
- Helper build: `apps/desktop/scripts/build-computer-history-helper.mjs`
- Main authority and IPC: `apps/desktop/src/main/computer-history-main.ts`
- Summary persistence: `apps/desktop/src/main/computer-history-summaries.ts`
- Model coordinator: `packages/runtime-host/src/server/computer-history-coordinator.ts`
- Model protocol: `packages/runtime-host/src/protocol/computer-history.ts`
- Preload bridge: `apps/desktop/src/preload/preload.ts`
- Renderer feature:
  `apps/desktop/src/renderer/features/module-hub/ui/computer-history-page.tsx`
- Native application metadata:
  `apps/desktop/src/main/computer-history-applications.ts`
- Capability/health projection: `apps/desktop/src/main/capability-snapshot.ts`
- Visual fixtures: `apps/desktop/stories/computer-history.stories.tsx`

The vendored collector is the MIT-licensed clean-room implementation from
`hqhq1025/open-codex-computer-history`, pinned to revision
`30c99f904d9375a01e17a05516f896ebda24a544`. Attribution is preserved in root
`LICENSE`, adapted source headers, and the packaged license directory.

## Why this fits Maka

Maka already has the correct downstream surfaces:

- Session Composer for explicit context use;
- Side Chat for exploratory questions that should not interrupt the main task;
- Daily Review for model-generated rollups over local activity;
- Skills and scheduled tasks for turning repeated workflows into automation;
- Permission Center for capability readiness and revocation visibility.

Unsummarized activity is still grouped deterministically by application, window,
and activity gap. Optional summaries reuse Daily Review's configured model and
the Host's existing auxiliary-model execution and accounting.

## Verification boundaries

Packaged/notarized helper verification and Windows collection remain separate
gaps. No live activity capture or paid model run is implied by fixture tests.
Deterministic tests cover native persistence, main-process lifecycle, retention,
corrupt-data recovery, cancellation, bounded projections, and renderer service
and draft ownership. Synthetic visual fixtures exercise the production page;
they do not demonstrate macOS privacy authorization or provider reliability.

The collector and summary pipeline remain draft-quality. The September 13, 2026
source audit identified unresolved browser attribution and document-origin
ambiguity, source identity loss, delayed AX callback attribution, and AX delta
baselines advancing before durable persistence. Text capture must remain off
during the current metadata-only trial; app names and window titles can still
contain sensitive information. Domain exclusions are not a proven security
boundary when browser attribution is unavailable or ambiguous.

Summary sampling favors early events, detail events are not necessarily the
events supplied to the model, existing windows do not refresh for late evidence,
and six-hour rollups can hide saved ten-minute documents from detail lookup.
The existing 30-day detail lookup also does not cover every retained archive.
These are follow-up correctness and provenance gaps, not guarantees established
by the UI tests. No production-readiness claim follows from the settings split.
