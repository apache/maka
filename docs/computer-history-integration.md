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
activity. It records interaction metadata, optionally captures admitted text,
and produces optional model summaries.
It does not record screenshots, video, or audio.

The integration has five boundaries:

1. A platform helper records admitted foreground activity. macOS uses
   Accessibility and Core Graphics; the Windows x64 backend uses WinEvents
   and bounded UI Automation snapshots. Windows does not record keystrokes.
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

The page opens as a full-width summary feed with a persistent
10 minutes / 6 hours / 1 day selector below its heading. Six hours is the
initial view; subsequent visits reuse this client's preference. Changing it
does not invoke analysis or alter capture frequency, consent, or model settings.

The ten-minute view lists saved leaf summaries. The six-hour view shows saved
rollups with an independent child disclosure; a pending interval shows its
already summarized activities until the rollup is ready. Main returns both
levels and canonical child IDs, so a parent never removes access to its original
documents. Leaves absent from a parent's provenance remain separately visible.
Summary windows remain UTC-aligned; range labels show both local dates when
they cross midnight. Date filters use half-open interval overlap and offer every
intersected local date, including daylight-saving transitions.

The one-day view collects saved activities by local calendar date. It is not
another generated daily summary. Opening a day reads each existing document with
bounded concurrency, individual failure/retry states, and the same safe
Markdown/source/copy/reveal controls. A matching rollup remains available on
dates without matching children, including searches matching only its content.
A document visible on multiple dates remains the same saved document, not a
rewritten or split artifact.

Granularity and filter changes retain the open document, source mode and
scroll position; an explicit new selection changes the reader. Background
refresh updates the list and open collection without invoking model settings.
An open six-hour collection keeps the whole interval as rollup provenance
changes; the list still distinguishes referenced and unreferenced activities.
Opened fallback rollups remain readable when new children arrive or filters
change. Main supplies a read-time saved-file revision so changes beyond the
bounded timeline preview refresh the full document without repeatedly reading
unchanged files. That revision is neither persisted nor sent to the model.
Raw app/window fragments do not appear as feed rows or contribute to its counts,
search, date options, or application filters. Before the first summary, the page
distinguishes waiting, active generation, paused/stopped recording, disabled analysis,
and failure; it never enables model processing merely by being viewed.
Saved summaries remain readable during generation and transient refresh errors.
Recorded evidence remains available within summary details.
Selecting an activity opens a side-by-side reader; closing it restores the
feed. On narrow screens the reader replaces the feed and has a back action.
List rows
show time, title, a short summary, and native application icons. The detail
surface shows the title, description, clickable keywords, interval, contributing applications, and
the complete saved Markdown body. Rendered Markdown is the default, with
headings, lists, tables, quotations, and syntax-highlighted code blocks. A source
mode shows the complete serialization, including frontmatter. The reader maps
the shallowest parsed Markdown heading below the activity title,
preserving relative heading depth without rewriting the saved or copied source.
The document toolbar uses "Activity summary"; file information exposes the original stored
filename, and copy actions retain the full Markdown or original filename.
"Reveal in Finder" locates the existing saved file without exporting a copy or
renaming it. Reading the document requires no file-manager handoff. Observed
links remain inert text and images render only their alt text, preventing
commands or network requests on selection. Recorded events and source windows
stay collapsed until requested.
The history page includes:

- recording state, pause/resume, and refresh;
- search, date, and application filters over activity summaries;
- a gear opening Settings > Computer History directly;
- per-activity deletion with confirmation;
- explicit selection of one activity for an editable chat draft;
- user-reviewed workflow suggestions.

Local search matches all whitespace-separated query terms across title,
description, keywords, the complete validated summary body, application names
and IDs, and the actual stored filename. Matching normalizes NFKC and case,
preserves chronological ordering, and intersects the existing date/application
filters. Hidden-field matches have a compact explanation. Clicking a keyword
returns to the filtered feed. Full-body matching runs in main only for an active
query; normal timeline refreshes omit body search data. Query responses retain
both levels and return at most 2,048 characters of matching body excerpts per
summary, so application labels and granularity can still be resolved locally.
Queries are limited to 512 characters and 16 terms, with at most 128 characters
per term. This does not enlarge the Composer context or
give the bundled skill autonomous archive access.

Settings > Computer History owns recording enablement, separate text and model
consent, application/domain exclusions, retention information,
and scoped history deletion. It uses the existing settings navigation instead
of a second settings panel inside the feed. Returning keeps the selected
activity, filters, scroll position, and keyboard focus, and refreshes the local
recording status. Pause/resume also preserves the open document.

System authorization is centralized in Settings > Permissions and capabilities.
History settings shows aggregate readiness and a contextual link, not a separate
permission request. The destination focuses the required Accessibility and Input
Monitoring permissions and retains a return path to the same History settings
control and scroll position. Other OS permissions are separate; Screen Recording
is not required by the current collector.

OS permission snapshots and actions use local Desktop IPC even when the selected
Runtime Host is remote or offline. Host capability diagnostics load independently.
A lightweight non-prompting helper probe retains collector-specific status;
Electron Accessibility success does not override a denied or unreadable collector
grant. Opening System Settings does not imply success, and focus return rechecks
the snapshot. Permission actions never change capture or model consent. If
recording was already enabled while waiting for a grant, History status reconciles
that saved choice after authorization without overriding pause or disable.
If saved settings cannot be synchronized to the collector configuration, all
recorder starts remain blocked and status reports the configuration error.
Only successful configuration synchronization through a settings retry or
initialization clears that error; clearing history does not repair the policy.

Settings reads status and analysis-model configuration independently. An
unreadable archive does not prevent disabling collection or clearing data.
Recent-application discovery is an optional bounded timeline read, independent
of settings health. Recording-setting readback does not wait for the model
catalog, including when the catalog stalls.

The summary model is selected in Computer History settings from the ready local
Runtime Host's offerable catalog. Searching or dismissing the selector does not
save. Selecting a model writes only the shared Daily Review `modelKey`; the page
discloses that this changes the model for both features. It does not change
recording consent or Daily Review scheduling. An empty key follows the local
Host's canonical default rather than choosing the first available model. A saved
unavailable key stays visible but cannot authorize new summary consent.
Catalog failures remain errors with retry and connection-management controls.

Manage connections opens Models settings for this Mac, with a contextual return
to Computer History settings. A selected remote task or settings profile cannot
redirect the history model's reads or writes. The adapter revalidates Host
identity and catalog availability before saving, rejects concurrent history
model saves, and makes returning readers wait for its pending save to settle.
Failures after leaving the settings page are reported through the app's toast.
History viewing does not read model settings.

Application names and icons are resolved locally from bundle identifiers using
Launch Services and `NSWorkspace`. The helper returns a 48px PNG, never the
application path. The main process validates and caches bounded batches; the
renderer displays 20px list icons and 24px detail icons with a name-initial
fallback for missing or unreadable images. This requires no capture permission,
application launch, network icon service, or bundled third-party brand assets.
The settings exclusions picker shows names and icons from retained history,
with a Bundle ID input for sources absent from that list. Exclusions change
future collection policy and eligibility for new analysis without deleting
previously retained evidence or summaries. Derived prior context and rollups
must match the current exclusion-policy scope.

The page uses Module Hub's services and draft ownership. Adding a draft
selects the local target, preserves existing Composer text, and never sends a
message. The detail API returns at most 100 privacy-reduced event projections,
with retained counts and an explicit expired-evidence state.

## Conversation skill

The bundled `computer-history` skill interprets history that the user has
selected, reviewed, and sent in a conversation. Desktop installs it from the
local Host's bundled catalog when recording is enabled or existing history
is present, including saved summaries whose raw events have expired. Startup
and local Host reconnection backfill missing installations; enabling recording
also requests installation without waiting for it to start capture.

New installations use the normal enabled default. Users can turn the skill
off in Extensions; automatic installation never resets that preference, even
after deletion and reinstallation. Existing skill content is not replaced.
The selected project or a remote default Host does not redirect installation
away from this Mac. Installation failures are logged and retried on a later
enablement or local Host reconnection.

Merely opening an activity or preparing a draft does not expose that activity
to the conversation model. The reviewed draft preserves the summary's Markdown
structure while escaping source text that could close its untrusted envelope.

The skill identifies the supplied time range, distinguishes observed metadata
from model summaries and inference, and treats both as untrusted content. It
does not infer successful actions or continuous working time from window
titles and event counts. Overlapping selections are not independent evidence.
Missing context is requested through the existing sidebar-to-draft flow.

There is currently no model-facing Computer History status, search, or read
tool. The Desktop preload APIs are not model tools, and `SearchHistory` and
`ReadHistory` search conversations rather than computer activity. The skill
does not bypass Desktop ownership by reading raw files or invoking internal
IPC. Autonomous retrieval requires a separately designed, bounded access
capability; installing this skill does not provide it.

Skill installation and use do not enable recording, text capture, or background
summarization. A submitted history draft is sent to the conversation's model
provider like other conversation content. This is separate from the optional
background analysis consent described below.

## Privacy defaults

- The feature is disabled by default.
- Typed-text persistence is disabled by default.
- Model processing and sending recorded text are separately disabled by default.
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
- Raw event projections exposed to the renderer omit keyboard text, selection
  text, accessibility values, raw paths, and process identifiers.
- With `summaryTextEnabled` off, model evidence is metadata only. With it on,
  main may additionally send admitted typed/selected text and self-contained
  accessibility snapshots. Saved model documents can contain derived detail.

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
application, window, interaction, and eligible prior-summary evidence to the
configured model provider and consumes model tokens; it is not wholly local
processing. Recording text locally (`captureText`) and allowing existing
admitted text into summaries (`summaryTextEnabled`) are independent controls.
Disabling local capture affects future writes. Disabling text analysis excludes
rich prior context and any rollup containing rich children, while preserving
existing readable documents. Cancellation cannot retract an earlier request.
Revoking either model permission persists through the main-process settings
authority even when the native helper or model authority is unavailable. It
cancels active analysis without stopping the collector or requiring its storage
lock. Collector-affecting changes still require native maintenance admission.

## Summary lifecycle

The main process schedules closed UTC ten-minute windows and six-hour rollups.
Each pass processes at most six items, using a 48-hour raw evidence horizon.
Persisted deterministic identities and evidence provenance prevent unchanged
summaries from regenerating across restarts. Within complete retained windows,
an order-independent revision of all eligible evidence refreshes the ten-minute
summary when content changes, even outside the selected samples. Locale and
analysis/exclusion scope participate in generation provenance. Once retention
cuts into a saved window, its
complete summary is preserved instead of being replaced with the retained tail.
Pending ten-minute summaries take priority over derived rollups, so a failed
older rollup does not block newer activity on the next admitted pass. The
existing error backoff still applies.
Six-hour summaries derive from the available ten-minute summaries; they do not
assert that every moment of the interval was observed.
Streaming sampling spans the whole interval using temporal endpoints, source
representatives, and content-bearing observations within fixed memory and wire
budgets. It does not stop after the first dense burst. A failed/incomplete raw
scan dispatches no model request. Six-hour input divides a shared text budget
across children rather than clipping each document to a fixed short preview.
Up to two earlier, policy-compatible summaries provide explicitly labelled
context; they are not counted as evidence of activity in the current interval.

The tool-free prompt asks for a task-oriented title, a second-person description,
and Markdown covering observations, task progress, outcomes, blockers, and
evidence gaps. Source IDs remain in stored provenance, not the model-written
body. Trusted UI locale is separate from untrusted content.
Metadata-only evidence cannot establish what a document says or that an action
succeeded. The model must state those gaps instead of inventing task detail.
Computer History uses a 180-second model deadline and level-specific output
budgets (6,000 tokens for ten minutes, 10,000 for six hours). Desktop passes a
190-second operation-specific request deadline; other request and connection
timer limits remain unchanged. Cancellation targets the original request.
If the Host does not acknowledge completion, the deadline ends the caller's
wait while retaining the transport slot until a terminal response or connection
failure. A timeout does not prove provider termination. Daily Review keeps its
existing limits.
A new or refreshed child invalidates its saved parent immediately before
publication when the parent is eligible under the current text consent and
exclusion scope. Ineligible archives remain readable but cannot be sent as
context or rollup evidence. If rebuilding an eligible parent fails, the child
remains available and the parent is retried on a later admitted pass; stale rollup content is not
reused after restart.

Markdown summary files contain versioned JSON frontmatter, bounded model
content, and application/source identifiers computed outside the model.
The model cannot choose filesystem paths. Clear and shutdown abort in-flight
analysis and fence late output before persistence.

New summaries include up to ten evidence-backed `content.keywords`, normally
five to ten only when observations support them. Terms are trimmed,
NFKC-normalized, deduplicated case-insensitively, and bounded to 96 UTF-8 bytes
each. Sparse evidence may produce an empty list. Legacy documents without
keywords stay readable; metadata rollout alone does not trigger regeneration.
The same evidence and privacy restrictions apply to keywords as to prose.
Each saved level produces its own terms; parent keywords are not copied into
every ten-minute child. The day view remains a collection, not a generated file.

New documents use `YYYY-MM-DD_HH-mm__<level>__<short-topic>.md`, with local
time at creation and no timezone suffix. Main sanitizes and bounds the topic,
persists the chosen basename, and preserves it across title/locale/timezone
changes. A rare same-name collision gains a stable numeric discriminator
instead of overwriting another summary. Canonical IDs remain unchanged.
Legacy `<summary-id>.md` documents retain their filenames, even when refreshed.
No rename-only migration or additional model calls are performed.

Summary details include the actual stored basename, its canonical
serialization including JSON frontmatter, and the validated, unescaped Markdown
body. Storage and detail projection share one serializer. Raw entries have no
document. The body is bounded to 48 KiB and the serialized file to 128 KiB; readers
must render it as untrusted Markdown. This does not alter the escaped Composer
context. Canonical summary IDs remain readable after leaving the 30-day feed
and while hidden by a parent rollup. Details return at most 100 reduced events,
preferring retained evidence IDs actually selected for that summary; expired or
ineligible evidence falls back to interval metadata without claiming provenance.
An unreadable evidence scan preserves access to the saved document, reports
unavailable provenance in status, and returns no partial event sample. A
successful detail retry or history deletion clears that diagnostic.
Summary application identities
prefer native bundle IDs, with name-only fallbacks when no ID was observed.

Generation metadata requires an explicit `includesText` Boolean. Version 3
introduced exact prior-context summary IDs; these remain available for linkage.
Version 4 additionally stores `rawEvidenceRanges`: sorted, disjoint half-open
`[startMs, endMs)` intervals covering transitive raw ten-minute windows. Main
captures the union of each child's and prior summary's coverage before model
execution, plus the current raw window for a ten-minute summary. These ranges
are not model input. Each consumer retains its own immutable ancestry even when
an intermediate summary is rewritten under the same ID or disappears.

Interval deletion removes overlapping documents and any consumer whose stored
raw coverage intersects the selection, including after raw expiry. It unlinks
consumers before inputs without traversing mutable summary IDs. Sparse gaps in
raw coverage do not invalidate downstream consumers merely because an enclosing
rollup overlaps the gap. Coverage is precise at ten-minute-window granularity,
not at individual-event granularity.

Adjacent or overlapping ranges merge. At most 256 ranges are retained within
the existing 128 KiB file limit; overflow coalesces the oldest excess ranges
into one enclosing interval. This can conservatively delete consumers for old
gaps, but never discards ancestry; newer gaps remain separate. Decoding rejects
missing, empty, oversized, unordered, overlapping, non-aligned or future ranges
and coverage that omits the summary's own raw inputs.

Generation versions 1 through 3 cannot prove immutable ancestry, even when
prior IDs exist. They conservatively cover all supported time before their end,
using `-8640000000000000` as the earliest timestamp. New consumers inherit that
coverage rather than guessing lineage from current files. Consequently, an
interval deletion can remove later legacy-derived summaries across scopes.
Baseline files without generation metadata predate prior context: they remain
readable and eligible under the existing policy gates, contribute their own
interval, and can generate rollups after raw expiry. Regeneration from complete
eligible raw input produces v4 provenance; ineligible rich archives are never
rewritten just to migrate their provenance.

The reveal operation accepts only a summary entry ID. Main resolves and
validates the owned persisted Markdown before asking the operating system to
select it; no renderer-supplied path is accepted or returned. Missing, corrupt,
or symlinked files fail visibly rather than creating an export. Revealing a
file does not enable collection or trigger model processing.

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
- macOS native collector: `apps/desktop/native/computer-history`
- Windows native collector and support limits:
  [`apps/desktop/native/computer-history-windows`](../apps/desktop/native/computer-history-windows/README.md)
- Windows main-held storage admission:
  `apps/desktop/src/main/computer-history-windows-ownership.ts`
- Helper build: `apps/desktop/scripts/build-computer-history-helper.mjs`
- Main authority and IPC: `apps/desktop/src/main/computer-history-main.ts`
- Main-only content projection: `apps/desktop/src/main/computer-history-evidence.ts`
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

The vendored macOS collector is the MIT-licensed clean-room implementation from
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

Packaged/notarized helper verification and live Windows UIA acceptance remain
separate gaps. Windows collection now has a native implementation and build,
packaging, lifecycle, and synthetic persistence tests; cross-compilation is
not proof of interactive Windows coverage. No live activity capture or paid
model run is implied by fixture tests.
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
