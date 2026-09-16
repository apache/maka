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
   and bounded UI Automation snapshots. Its passive input path admits selected
   action facts for verified native controls, not typed characters.
2. The Electron main process owns the helper lifecycle, raw files, privacy
   settings, retention, deletion, and timeline projection.
3. The preload bridge exposes bounded status, controls, and reduced timeline
   entries. It never exposes raw JSONL paths or event bodies.
4. The local Runtime Host executes optional analysis using its existing Daily
   Review model authority, without tools. Collection and model processing require
   separate consent. Model summaries are written locally by the main process.
5. The user can select history for an editable conversation draft or approve
   bounded retrieval through existing Desktop Client Capabilities. Both use
   untrusted observations, never automatic promotion to long-term preferences.

This follows the released Computer History generation: an interaction-event
stream, not the older screenshot/OCR Chronicle design.

### Platform parity target

macOS must match the verified Computer History behavior of the pinned Codex
reference, and should improve evidence completeness, retrieval and reading
without weakening privacy or increasing background work unnecessarily.
Windows must match Maka macOS's user-visible outcomes through the same summary,
model-connection, Skill, permission, archive and reader owners. Platform APIs
may differ; a common JSON envelope alone does not establish parity.

Acceptance compares the same scripted tasks and known facts, not event counts:

| Dimension | Required evidence |
| --- | --- |
| Capture completeness | Known facts survive first open, same-window edits, scrolled document tails, selection changes, short intervening tasks and sustained terminal output |
| Action semantics | Distinguish observed input, selected text, shortcut, submit key and visible result; never infer successful submission or execution from a changed snapshot |
| Summary quality | Retain task objectives, material decisions, artifacts, failures, competing proposals and last state; distinguish old output, current observations and prior context |
| Cross-platform consistency | Equivalent permitted Mac/Windows observations retain the same task facts through projection, ten-minute summaries, six-hour rollups and retrieval |
| Responsiveness | Measure change-to-record, record-to-summary and summary-to-reader freshness at unchanged test deadlines; collect idle/burst costs separately |
| Privacy | Useful allowed-body baseline precedes password, private-window, excluded-domain/app and revocation negatives; prohibited facts never appear in retained or transmitted evidence |
| Recovery | Pause/resume, process exit, provider failure, failed writes and session transitions preserve ownership and admit only fresh observations afterward |
| Conversation use | Actual local Host and Session flow discovers the Skill, requests approval, reads bounded summaries and answers from them; denied or revoked access performs no content read |
| Reading | Keep the selected sidebar, ten-minute/six-hour/day views and complete Markdown reader; selection and scroll survive refresh and granularity changes |

Record whether each comparison is source inspection, deterministic execution,
native live acceptance, real-model acceptance or complete Desktop acceptance.
Only a matched live Codex/Maka experiment supports an empirical Codex parity
claim. A provider API's existence, compile success, test count or richer prompt
does not substitute for that experiment. Tests with a deterministic model
measure evidence transport, not language-model factual accuracy. Report missing
native capabilities separately from implemented but unverified behavior.

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
unchanged files. That revision is not persisted; conversation tools return it
as an opaque token to prevent combining pages from different document versions.
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
per term. This does not enlarge the Composer context. Conversation retrieval
uses the separate bounded and approved tools described below.

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
Launch Services and `NSWorkspace` on macOS. Windows first resolves requested
`win32.*` identifiers from unambiguous running local executables, using version
metadata and a native icon. A previously resolved icon remains in the same
bounded session cache when native enumeration explicitly confirms the app
is no longer running. This cached state is rechecked after thirty seconds.
Failed reads, ambiguous executable paths and cache eviction revoke retention.
For a confirmed non-running ID, the helper can query that executable's exact
App Paths registration in the canonical 64-bit view of each user/machine hive.
These keys are shared with 32-bit writers on supported Windows versions;
the helper does not traverse the compatibility alias.
Registrations must agree on one bounded local executable path; commands,
expansion, registry links, redirected files and unreadable candidates are
rejected. The helper pins the file and its ancestors while reading metadata
and rechecks the registration, file identity and running candidates.
A registration result uses the existing positive cache but cannot seed
after-close retention when the registration later disappears. Unregistered
closed apps retain the name-initial fallback; there is no installed-app scan,
persistent path cache or executable launch.
For packaged applications, the collector reads the exact AUMID from its held
process handle, rechecks it before publication and retains the executable
identity as an exclusion alias. Shared grouping, summary metadata and search
use `winapp.<AUMID>` without clipping, case normalization or path disclosure.
Either packaged or executable exclusion suppresses the source, including drag
endpoints. Invalid supplied identities cannot fall back to a display name.
Native lookup resolves the exact requested AUMID through the current package
registration, verifies identity and version around the read, and returns bounded
display metadata. It does not enumerate installed packages or use a host
process's children to guess historical identity. Current registered metadata
cannot seed closed-process icon retention.
Main and the existing recent-application, metadata and exclusion controls share
one core identifier grammar, so supported IDs remain usable across the entire
settings flow.
The helper returns a 48px PNG, never the
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

The bundled `computer-history` skill retrieves permitted recorded activity and
interprets history that the user has reviewed and sent in a conversation. Desktop installs it from the
local Host's bundled catalog when recording is enabled or existing history
is present, including saved summaries whose raw events have expired. Startup
and local Host reconnection backfill missing installations; enabling recording
also requests installation without waiting for it to start capture.

New installations use the normal enabled default. Users can turn the skill
off in Extensions; automatic installation never resets that preference, even
after deletion and reinstallation. Unmodified installed bundled content upgrades
transactionally to the current bundle without changing enablement or pinning.
Customized or unverifiable installed content is preserved.
The selected project or a remote default Host does not redirect installation
away from this computer. Installation failures are logged and retried on a later
enablement or local Host reconnection.

Merely opening an activity or preparing a draft does not expose that activity
to the conversation model. The reviewed draft preserves the summary's Markdown
structure while escaping source text that could close its untrusted envelope.

The skill identifies the supplied time range, distinguishes observed metadata
from model summaries and inference, and treats both as untrusted content. It
does not infer successful actions or continuous working time from window
titles and event counts. Overlapping selections are not independent evidence.
Retrieval uses the existing Desktop Client Capability channel under the local-only
`desktop_computer_history` offer. It accepts no Host filesystem paths.
`ComputerHistoryStatus` returns narrow readiness fields without activity content;
`ComputerHistorySearch`, `ComputerHistoryRead` and `ComputerHistoryReadEvents`
use the existing managed session-approval mechanism. The permission prompt names
the conversation-model transmission. `SearchHistory` and `ReadHistory` still search
conversations, not computer activity.

Search streams validated summaries, matches complete bodies and keywords, and
returns bounded excerpts. It defaults to 24 hours, accepts at most 31 days, and
pages up to 20 results with a chronological cursor. The first search omits the
cursor; subsequent pages copy the returned interval and cursor with the same
query and level. Automatic granularity prefers
six-hour summaries in broad intervals while retaining leaves not referenced by a
matching parent. Read returns paged Markdown with the saved document revision,
source IDs and explicitly separate prior-context IDs. Follow-up pages require the
same revision. Neither operation exposes local file paths.

Raw-event reads require recorded-text transmission consent, are limited to ten
minutes within the retained 48 hours, and return at most 50 projected events under
a shared byte budget. Individual observations use up to 32 KiB of encoded
content per read; the complete event list remains bounded to 40 KiB plus its
small response envelope. Truncated content returns `nextOffset`. Further pages
copy that offset and the exact returned event ID with the same interval.
The ID binds the complete projected observation, including its full returned
metadata. List pages copy `nextAfter` to `after` with the same interval and
without event-content selectors. This opaque token identifies the admitted
prefix, distinguishes identical same-time records and invalidates on prefix
or exclusion-scope changes. It requires no persistent cursor state or paths.
Appending later records does not invalidate an unchanged prefix; this is not
an immutable snapshot of the entire interval. Native partial capture remains
partial after every page has been read. Main reapplies source exclusions,
checks archived summary policy provenance and text consent, redacts recognized
secrets before clipping observed text, and serializes reads with local
settings/deletion. Selection and accessibility truncation remain explicit.
Summary searches and reads reject a result if archive publication overlaps
any scan or final access check, so a concurrent rollup rebuild cannot combine
old parent coverage with new children. The caller retries the complete query.
The effective bundled
Skill preference, current local Host and incognito are checked before and after
each data read. Disabling the Skill or revoking consent blocks further retrieval.
Old summaries without verifiable policy provenance remain locally readable but
cannot be sent through these tools. Tool results are untrusted observations.

Skill installation and use do not enable recording, text capture, or background
summarization. A submitted history draft is sent to the conversation's model
provider like other conversation content. Tool data reads require both background
model-processing consent and the managed conversation approval; eligible UI text
additionally requires the existing recorded-text transmission consent. The
conversation provider may differ from the analysis model. None of these tools
change recording, permissions or model connections.

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

When eligible native events provide action details, the main-only projector
preserves bounded shortcut/submit keys, mouse button/count/modifiers, drag
endpoints and selection positions alongside the observed text. Mac selection
location/length and Windows start offsets are explicitly UTF-16; absent lengths
are not inferred from clipped text. Mac selection ranges are rechecked after
content reads; a changed or newly unavailable range invalidates the observation.
Selection `truncated` describes collector clipping, not provider completeness;
legacy or missing text leaves it unknown. Text-disabled persistence removes both
the selected text and its clipping flag while preserving the metadata range.
Current app/domain exclusions and secure
roles apply to both drag endpoints before returning even event metadata.
Action details use the same text-transfer gate and redaction budget as bodies;
no raw native object or unrestricted filesystem path is transmitted.
Native-sized input, selection and target values retain up to 8 KiB each inside
the unchanged 28 KiB total event-content budget. Supported modifiers include
macOS `fn`; malformed security-role fields suppress the observation without
interrupting enumeration.
Selected list/table items use this same projection and permission boundary.
At most 32 item descriptions pass through the existing redaction and 28 KiB
event budget; malformed arrays and secure or malformed item roles suppress
the event. Native item labels are observations, not proof that an item was
opened or acted on. Renderer event previews continue to omit their text.

For admitted standard Windows Edit controls whose UIA scalar is clipped, a
bounded system-marshalled `WM_GETTEXT` read preserves the body and selected
tail. It retains class, process, root, focus, password, tree and selection
checks; a failed read does not reuse the clipped scalar as complete content.
Other providers retain their own visible-range and selection paths. Recorder
teardown attempts input shutdown, segment sealing and runtime publication even
when an earlier step fails, retaining the first error.

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
older rollup does not block newer activity on the next admitted pass.
Malformed summary output is retried per generation identity with exponential
backoff capped at six hours; other windows continue within the six-call budget.
Provider-wide failures stop the pass and share a ten-minute cooldown. Storage,
privacy and unknown failures are never silently classified as malformed output.
Manual retry resets eligibility; new evidence or policy revisions invalidate
only applicable window retries. A successful earlier-window repair refreshes
its dependent prior context and rollups.
Six-hour summaries derive from the available ten-minute summaries; they do not
assert that every moment of the interval was observed.
Streaming sampling spans the whole interval using temporal endpoints, source
representatives, and content-bearing observations within fixed memory and wire
budgets. Full-content candidates share a 224 KiB encoded evidence budget rather
than losing their tails to fixed 1/3/7 KiB previews. A bounded sample retains
short intermediate observations as well as endpoints and rich content.
It does not stop after the first dense burst. A failed/incomplete raw
scan dispatches no model request. Six-hour input divides a shared text budget
across children rather than clipping each document to a fixed short preview.
Long accepted children span bounded continuation items, accounting for JSON
escaping and retaining canonical child IDs in saved provenance. The total
evidence budget remains 224 KiB. Only affected retained rollups receive the
new input revision; complete dependencies and compatible consent/scope are
required, and expired saved rollups remain intact. Failure or cancellation
preserves the old document. Later consumers may refresh through the existing
prior-context revision mechanism after a successful repair.
Normally up to two earlier, policy-compatible summaries provide explicitly labelled
context; they are not counted as evidence of activity in the current interval.
Within the same 8 KiB context budget, new or changed windows can combine one
recent summary with one matching summary from more than six hours and at most
31 days earlier. The query uses only admitted current text, excluding application
identity, source IDs, prior context and proposed workflows as query anchors.
Selection requires two independent exact keywords, including a code-like
identifier or explicitly named Chinese project; ordinary-language-only matches,
application-only matches abstain. When exactly two highest-scoring older choices
are independently supported and pairwise nonoverlapping, both can accompany the
latest recent summary, for at most three context items. More than two tied choices
or overlapping choices retain the recent-context fallback. The complete matched
excerpts and headers of both alternatives, plus a bounded recent body, must fit
the same 8 KiB encoded budget; otherwise neither alternative is offered.
Recognized prior-context
and suggestion sections do not supply the older match. The input includes the
matched body excerpt, including tail passages beyond the normal preview.
This is conservative lexical retrieval, not semantic relevance or reliable
detection of unlabelled historical paraphrases. If nothing qualifies, the
existing recent-context selection is retained.
The final summarizer receives all alternatives in its existing single call and
is instructed to assess them independently, ignore unsupported continuity and
leave unresolved conflicts uncertain. There is no separate model-selection pass,
tool call or model configuration. These are transport and prompt guarantees,
not evidence that a model always chooses the correct earlier task.

Saved generations pin their prior-summary IDs. Archive arrival alone does not
regenerate unchanged windows; changed raw evidence, children or existing
dependencies can select context again. With unchanged raw evidence, missing or
newly prohibited pinned dependencies prevent partial replacement. New
ten-minute summaries also persist an independent all-event source revision,
so an unsampled same-count replacement remains detectable after restart when
prior context is unavailable. Confirmed new raw evidence can then select
currently eligible context without carrying forward the missing claims.
Older documents lacking this independent revision stay unchanged unless their
recoverable combined revision, event count or sampled IDs establish a change.
Adding freshness bookkeeping alone does not rewrite archives or invalidate
their consumers. Each consumer still snapshots the
complete transitive raw-interval ancestry, without clipping it to the retrieval
horizon. Every exposed alternative is a dependency, even when the returned body
does not mention it. A per-run keyword index avoids scanning every archive body for every
catch-up window. Old readers limited to six-hour prior references cannot read
new documents containing these longer references. Readers limited to two saved
prior IDs cannot read new three-prior documents; Host epoch 157 rejects older
wire peers before dispatch. Legacy short-reference documents remain supported
without bulk rewriting or a global summary-generation version change.

Saved workflow suggestions enter child and prior-summary evidence as untrusted
proposals with unknown installation and approval status. Suggestions require an
observed coherent reusable process; automation timing must be evidenced.
Earlier overlapping proposals suppress duplicate suggestions. A six-hour
rollup may retain a still-supported child proposal, not combine unrelated
proposals into a newly invented workflow. These prompt rules do not install
Skills, schedule automations or prove that a model followed every instruction.

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
eligible raw input produces v5 provenance with the same immutable coverage contract;
the v5 identity rebuilds retained summaries with the richer sampling. Ineligible rich archives are never
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

Revision `c73755700` on September 15, 2026 passed native live acceptance with
isolated synthetic applications. macOS Intel VM checks covered read-only
AppKit bodies and scrolled tails, same-title sources, four input/consent modes
and six Chrome scenarios. Native unit tests and release builds covered ARM64
and Intel; live ARM application coverage is separate.

Windows MSVC and Node checks covered kernel ownership, storage and shutdown.
WinForms covered body/selection changes, app icons, multilingual text, privacy,
pause/resume and provider recovery. Eleven Edge scenarios passed useful body,
focused-frame/domain, private-window and cold-start checks after fixing the
earlier cross-process/document-source failures. The final six-case WPF run
also proved that unsupported optional selection retains admitted body. These
are specific provider/version results, not support for every application.
WinForms/Edge were not repeated after that last narrow selection repair.

The September 15-16 selection follow-up passed 85 Swift tests and both release builds.
The final Intel helper also passed real AppKit selection recording with text
enabled and disabled: Unicode prefixes, original UTF-16 coordinates, explicit
collector clipping, clear/reselection, stable source identity and sealed
shutdown. The race itself is covered by deterministic in-read mutations;
stable live selection does not establish an atomic AX snapshot. The existing
VM was restored to its original paused state after synthetic evidence export.

The final drag and overlapping-button correction passed 94 Swift tests and
both release builds.
The existing event tap now consumes dragged coordinates so an observed excursion
followed by a return to the press point remains a drag. Button mismatch, tap loss,
pause, source invalidation and rotation clear pending gestures. Movement adds no
accessibility or body reads; original endpoint privacy checks still govern writes.
Direct recorder regressions verify lifecycle cleanup without starting capture.
The final Intel VM helper passed eight cases in each of text and metadata-only
modes: out-and-back drag, stationary click, other-button drag, overlapping-button
rejection, secure origin, secure destination, pause and focus cancellation.
Each negative case was followed by a successful recovery drag. Independent
JSONL readback confirmed 27 events per mode, omitted prohibited text, sealed
shutdown, no remaining owned guest processes and restoration of the original
VM pause. This exercises CGEvent delivery and the real event tap and AX
provider, not physical hardware or a successful application drop.

The subsequent mouse-up review reproduced a cancelled gesture being published
under a newer running-control revision between endpoint reads. The recorder now
retains one generation through origin, destination and persistence. Its actual
recorder regression failed at both read boundaries before the fix, then passed
normal write, rejection and recovery in both text modes. Tests now supply valid
synthetic snapshots instead of setting pending content directly. All 96 Swift
tests and both release architectures passed. The extracted-method reproducer
retained one stable drag and zero cancelled drags. The latest Intel release
then passed the same eight AppKit event-tap/AX scenarios in each text mode.
Independent readback verified all 54 events, five negative/recovery cases per
mode, source/endpoint attribution, text omission and sealed cleanup. The
original VM pause state was restored. The inter-read race itself remains
deterministic recorder/store coverage, not live race injection or physical
device acceptance.

Normal duration completion now revalidates and flushes the final typing burst
before sealing, instead of discarding it through the cancellation path.
Actual-recorder tests reproduced the stop-only loss, then passed retention in
both text modes, idempotent completion and rejection after pause, stop, changed
source, secure/unavailable context or a control revision changed during the
final read. This is permission-free synthetic recorder/store coverage; earlier
live gesture acceptance does not establish the new duration behavior.

Selected-children/rows notifications now retain at most 32 independently
admitted selected items, with 8 KiB total encoded labels. The selected subtrees
are checked before any leaf content read; parent/container aggregate values
are not read. Membership, paths, security, domains and process/window state
are rechecked before returning. Text-off capture retains only item roles;
private in-memory identities prevent an identically labelled replacement from
being deduplicated. Clearing selection resets delivery. The combined macOS
source passed all 108 Swift tests and both ARM64/Intel release builds.
Real provider notification delivery for this new callback remains unverified.
Main projection and service tests confirm selected labels reach summary input
and permission-checked raw retrieval, while timeline/detail metadata and
text-denied queries omit them. The current combined main, evidence and summary
suites passed 251 tests; no real model call was made for this follow-up.

The selected-item review then corrected two gaps. Selected text areas now reuse
the existing visible-range reader and final witnesses, so selected-item capture
cannot silently fall back to an offscreen value prefix. Notification registration
retains each node's next unattempted notification and resumes after its deadline;
the periodic body sampler cannot replace missing selected-row notifications.
The existing timer and registration bound are reused. Completed attempts are
not repeated; recovery from transient registration-provider errors is separate.
Actual selection-queue tests also cover the item flag, original source/window,
delayed dispatch, cancellation and final JSONL in both text modes.
The reviewed combined source passed 113 Swift tests and both release builds.
These are deterministic acquisition/routing checks, not live provider delivery.

Windows follow-up acceptance passed seven WPF and eleven Edge scenarios using
the final visible-range/body capture code. A metadata-only rebuild then passed
98 MSVC tests, thirteen native Node tests, the complete WinForms body/selection/
privacy/recovery matrix and standard Edit physical-input acceptance.
The WinForms assertions include an unselected body tail beyond the UIA
4096-unit scalar prefix, long multilingual selections, 8 KiB clipping,
over-budget offsets preserving body and aggregate text ordering. The input
fixture verifies Return, Ctrl+A, a Return after six seconds idle, exact-child
clicks, action-only persistence and sealed cleanup. RichEdit diagnostics found
that the legacy .NET UIA client reports Pane while the production CUIAutomation8
client reports Document for the same native child. The production provider's
ValuePattern contains its own text, not a source URL. A test client's provider
shape cannot substitute for the actual collector's source and privacy checks.

The subsequent RichEdit path reads only explicitly nonhidden, independently
validated visible runs from admitted native leaf Documents. Unfocused visible
siblings may contribute body; focused native-child checks still own input
admission. A contained collapsed match leaves the remaining tail unread, and
all such body samples carry truncation. Hidden/unknown attributes, changed text,
escaped endpoints and failed source revalidation reject capture; there is no
whole-body or Rich selection fallback. Text-disabled capture performs no Rich
body reads. The standalone production-client probe established one stable
49-byte nonhidden run, not complete document coverage. The new production
recorder harness separately requires body/edit, hidden-text omission,
password suppression/recovery, both consent modes and sealed JSONL.

The newer Windows source retains full DWORD standard-Edit selection offsets,
including carets and ranges beyond 65535. Numeric-only ranges require no body
read and survive unchanged text-disabled policy; either policy transition
rejects the in-flight capture. The final-policy regression failed against the
previous filter and passed after repair. A private, short-lived UIA subscription
worker additionally binds WPF/Chrome keyboard targets to exact element/document
identities and the real native focus host. One-shot observations cannot grant
that input authority. Deterministic tests cover initial-frame admission,
identity/content changes and retired-reader isolation. Completed content-only
retries retain the same live child without renewing action/source deadlines.
Worker EOF closes admission without inventing an external source change;
first terminal reason/time and atomic child disposition preserve failure
visibility and backoff even when EOF races completion. The original action-loss
and failure-classification regressions failed before repair, followed by an
independently reproduced late-EOF race. Final local lifecycle tests passed
23/23 and Windows-target Clippy passed. The same atomic-retirement generation
subsequently passed 180 actual Windows MSVC tests with two explicit interactive
skips, including the real Pending/retained-action/late-EOF regression, and built
in release mode. These results do not replace actual provider acceptance.

That generation's cold WPF recorder test failed its first physical Return:
body capture and an independent UIA identity probe passed, but the recorder had
not yet established its own input lease. Successful one-shot body capture set a
lease request that waited for the normal three-second cadence. The independent
probe could not confer input authority on the recorder. A separate Rich recorder
test failed before body/input assertions when a direct snapshot overlapped the
newly resumed recorder. The returned timeout can represent either the 700 ms
capture limit or a provider timeout; the exact expensive stage is unverified.
Both runs ended with sealed segments and clean owned-process shutdown. They
remain failed acceptance, regardless of unit-test or wrapper exit results.
The cold-start repair now grants one immediate upgrade attempt for an admitted
one-shot without an input target, retaining its source, policy and two-second
age bound. Only a valid recorder-owned lease frame can admit later keys. Local
lifecycle26/26, UIA admission3/3 and strict Windows-target Clippy passed; an
independent source review cleared the correction for native retesting.
That exact cold-upgrade generation then passed 183 actual MSVC tests, with
two explicit interactive skips, and built in release mode. Full test and
release logs were retained. Its fresh WPF run still missed the first physical
Return despite two persisted body events; the fixture received the key.
The final stopped health had zero failures, but no intermediate health samples
or recorder-child stage trace were retained. The remaining first-key cause is
unresolved; neither an independent lease nor the scheduling correction proves
recorder input acceptance.
The Rich harness now requires the cold recorder's useful body before auxiliary
probes and pauses until workers retire. Direct capture uses a separate validated
home with identical policy and running control but no recorder, since a paused
home must reject capture. Resumption requires a fresh persisted source before
physical input. Capture and assertion deadlines are unchanged.
The same 183-test generation failed this isolated cold Rich gate with one
capture failure and two sealed, empty segments, before any auxiliary probe or
physical input. Thus overlapping probe activity cannot explain that run.
Its child error and stage were not recorded, so the failure subtype remains
unknown. Both newer runs cleaned up their owned processes; they are failures,
not replacements for the earlier successful provider cases.
Eight deterministic receipt/ledger/cleanup checks passed across the browser,
WinForms and WPF harnesses; the Windows workflow runs them with desktop
capture explicitly disabled. Native outcomes remain a separate gate.

The source-renewal follow-up separates worker liveness from recorder input
authority. A newer same-source verifier must pass final admission before both
the previous five-second source deadline and its own two-second operation
deadline. Its start time anchors the next source deadline. A parsed frame,
notice, null result or retained content-only retry cannot renew authority.
Worker birth, terminal state and original queued-action ages remain unchanged.
One adaptive early refresh reserves the operation budget and two polling turns
without bypassing provider-failure backoff. Local transition tests reproduced
the old fixed-worker expiry gap; lifecycle30/30, combined native-source158/158
and strict Windows-target Clippy passed after the change. The Windows-only
actual Pending regression compiled but awaits native execution. These checks
do not resolve the separate first-Return or cold Rich acceptance failures.

The isolated archived-183 WPF diagnostic positively recorded the first physical
Return being rejected before it entered the action queue: callback at 2.549 s,
no admitted input scope, and first scope installation at 4.880 s. The first
lease had reached EOF at 1.826 s; its cause remains unknown. A later lease
emitted an initial invalidation, causing the parent to request snapshot 1 and
discard a valid snapshot 0. The worker now coalesces nonrevoked notices only
before its first capture, preserving revocation, changes during capture,
exact delivered-stamp acknowledgement and all later notices. Four new permanent
regressions and an extracted actual worker branch passed after reproducing the
old failure; strict Windows-target Clippy passed. This removes the verified
redundant initial capture, not the unresolved first EOF or full first-key gap.

The isolated archived-183 Rich cold diagnostic then reproduced a 700 ms
capture-budget failure during final visible-range revalidation. One child
reported 180 ms root preparation, a 431 ms tree walk including 246 ms of
Rich-range work, and 30 ms final-range checks. The range phase made 476
provider reads across two leaves; nested durations must not be summed.
Received counters showed no UIA timeout or other provider error. The fixture
never produced a persisted body; both segments sealed empty and owned
processes exited. This identifies the failed budget/stage, not a successful
optimization or provider-parity result.

The WPF deferred body path now shares traversal-ordered insertion offsets with
standard Edit. Later labels cannot consume an earlier TextBox's body budget,
including mixed providers and unnamed controls with equal offsets.
The actual walk/collect sequence failed three deterministic content/order
cases before and passed all four afterward; the 24 snapshot tests and strict
Windows-target Clippy passed. Provider/privacy checks and byte limits remain.
Live provider verification of this narrow ordering change remains separate.

The current Windows source supersedes the one-shot cold-upgrade implementation
above. One adaptive worker prepares any required WPF/Chrome subscription before
its single body traversal. Native and body-only outcomes return one initial
terminal frame; parent admission requires clean EOF, successful exit and all
original policy, source and deadline checks. A terminal result never grants
external UIA input authority. Subscription setup failure counts as a failure
even when independently safe body is absent, and cannot become healthy merely
because body is retained. External cancellation takes precedence. The actual
reader/Pending/Store composition passed six cases after reproducing that null
failure misclassification; worker and host source suites passed 23 and 162
tests, and strict Windows-target Clippy passed. Windows execution of the new
Pending tests and actual first-Return acceptance remain pending.

At the same existing Rich validation boundaries, a fresh element-only metadata
cache now includes NativeWindowHandle with the state properties. The controlled
actual-method test reproduces two provider transactions before and one after,
and rejects source/privacy mutations at later boundaries. All three cases
passed. No cache crosses a text read, and hidden-text, childlessness, enclosing
element, range, text-equality and final viewport checks remain. This reduces a
verified call count; native latency and the earlier cold Rich timeout are not
yet established as repaired.

Windows item-selection capture now uses SelectionPattern membership and each
member's SelectionItemPattern container, not matching text labels. The existing
observed tree must contain the complete admitted selection owner, paths and
selected subtrees. At most 32 ListItem/TreeItem/DataItem members contribute
`AXRow` records; childless UIA Text names supply bounded samples. Each sample
reuses the full ancestor/document check immediately before and after its read.
Focus, runtime identities, membership and tree checks repeat before return.
Only roles and consented samples reach JSONL; runtime identities remain private
to replacement detection. An empty item array represents confirmed clearing.
This initial Windows reader is narrower than macOS's leaf title, description
and visible-value reader, and has not yet passed a live ListBox acceptance run.

The Mac selected-leaf reader also revalidates source ancestry, document
identities, membership and window title around each content operation,
including between visible-range metadata and ranged text. A final rejection
alone did not prevent subsequent attribute reads after a source changed.
The mutation regression failed before this repair; the combined Swift suite
now passes 115 tests and both ARM64 and Intel release builds pass. These
checks do not measure live AX latency or provider notification delivery.

The subsequent synthetic Intel AppKit acceptance passed both text-consent
modes with five positive and five negative cases each. It exercised cold body,
repeated selection, row/table replacement, sensitive-state suppression and
recovery, then independently replayed the complete exported12-event ledgers.
Default-denied website policy no longer rejects an admitted local app solely
because it has no URL. Capture-to-persistence privacy regressions bring the
Swift suite to119 passing tests. The52.467s native run verified child cleanup
and original VM pause restoration; it used no physical input.

The acceptance oracle retains observed append-start and append-end positions.
Native ISO8601 timestamps have whole-second precision, which cannot reconstruct
subsecond operation boundaries during final replay. Timestamp checks remain
at the serialized precision, and the complete selection-event ledger still
rejects duplicate or unassigned records.

The combined Windows source also fixes two mouse-pairing errors. Unknown
modifiers previously skipped physical releases, permitting a retained down to
pair with another press's up. Interruption also cleared the held-button mask,
allowing a second button's click while the first remained held. Releases now
update observed button state before admission; uncertain input cancels pairing
without resetting held buttons. The actual callback-to-action reproducer failed
all three cases before and passed all three after. Combined host tests passed
178 cases, with strict Windows-target Clippy and formatting checks passing.
Native Windows MSVC tests subsequently passed 215 cases with two ignored,
followed by the same generation's release build and 15 native Node checks
with no skips. The guest toolchain has no Clippy component, so native strict
lint remains unavailable; the passing cross-target lint is a separate check.
The first cold-WPF run retained useful body but its external input driver
rejected the request before sending a key. It therefore establishes no
first-key result. The driver used wall clocks from different machines for
freshness; clock-skew reproductions fail before dispatch. A repaired acceptance
driver must preserve the original request deadline and 750ms freshness bound.

The subsequent selected-member repair treats initial unsupported roles or
explicitly absent SelectionItemPattern as optional item-selection absence.
It retains independently admitted body only after the original final checks.
All members still undergo admission: a later provider error, offscreen or
unobserved member, oversized selection or changed source rejects the capture.
Once item content has been sampled, final capability loss also rejects it.
The three regressions failed before and passed after repair; independent
source review, 181 host tests, Windows GNU strict all-target Clippy and
formatting passed. This newer repair is not covered by the 215-case native
generation and still needs complete COM-backed Windows acceptance.

The native215 ListBox run subsequently passed its cold two-row identity check,
then timed out waiting for clear. The recorder reported no capture failures.
The List had no input target, so the input-only lease lifecycle closed its
worker and the ordinary fallback interval exceeded the acceptance gate.
Current source retains observation-only workers for validated item owners,
including confirmed empty selections, and adds SelectionItem/Name content
notifications. Source/owner replacement requires fresh admission; observation
renewal cannot authorize physical input. The original two-second operation
and five-second lease limits remain. The regression failed before the fix.
Metadata-only owner validation now precedes subscription installation, followed
by label sampling; a label change during installation cannot enter the initial
sample unnoticed. Observation renewal performs final admission after projection
and source comparison. Both ordering regressions failed before repair;
186 host tests and strict Windows GNU all-target Clippy passed. Native
delivery of this combined source remains pending.

The later native215 Rich diagnostic also failed before body persistence,
with positive evidence of local budget exhaustion during tree traversal.
Recorded preparation took259ms; traversal took472ms including283ms of nested
Rich work. These durations must not be summed. Emitted records contained no
provider errors or UIA timeouts, but one diagnostic line was discarded, so
trace completeness is not established. This result does not show that current
source completes within the unchanged700ms capture limit.

Native selected-item acceptance must verify attribution, not just that all
expected labels occur somewhere. Bind each native sample to its independently
witnessed item identity and require distinct persisted rows. Sealed readback
must inspect all file bytes and reject unfinished JSONL tails; the live reader's
partial-write tolerance is not suitable for completed archives. The source
packets cover these failure cases before any native run. Cold input acceptance
must also precede auxiliary UIA lease probes, which can initialize a provider
and conceal first-action loss.

The shared follow-up passed 349 combined Desktop tests across main, summaries,
evidence, application metadata, settings, Skill installation and capability
publication, including exact packaged identities and the conditional prior
shortlist. A native lock probe timed out in the initial concurrent batch,
then passed unchanged in isolation and in the final concurrency-two batch.
No production cause or timeout adjustment was established by those results.
The current renderer typecheck and scoped Biome checks also passed. The
current Host summary protocol, coordinator, compatibility and general protocol
suites passed 115 tests at the earlier epoch156. A later upstream refresh to
27add3049 independently adopted157, so this branch now uses158. The forged
upstream157 peer incorrectly connected before the repair and rejects before
domain admission afterward; the rebuilt handshake/protocol subset passed20.
This does not establish newer-main integration.
Native input characters are labelled as observations, not proof of committed
application text, finalized IME composition or submission. Tests preserve them
separately from an observed control value and remove both when transmission is
disabled.
After replacing an OS-file-notification wait in the revocation test with the
existing post-write timer reconciliation checkpoint, all 118 main tests passed
again. An earlier combined run stalled; the unchanged full and combined
reruns passed, so no production root cause was established from that stall.
Tests still read the actual saved opt-out while a deferred provider has not
acknowledged cancellation and assert no new model work or collector restart.

The existing Coproxy Astra route generated and read back valid Markdown.
Approved Skill -> Search -> Read acceptance used the actual backend, SQLite
grant authority, production offer factory and native capability provider, but
initially an in-memory transport. A subsequent built-Desktop run at `c73755700`
passed boot-time Skill installation, actual local Host socket, SessionManager,
renderer Allow click, Search, Read and a grounded answer in 21.319 seconds.
Recording stayed disabled; the prewritten synthetic summary's tail marker was
absent from Search and present in Read and the rendered answer. One Session
grant and 18 runtime events were read back from SQLite. The initial harness
misread a Desktop composite session key as a Host UUID; the corrected offline
verifier confirmed the same run without another model call. This validates
the built-app retrieval path, not notarized packaging, live recording-to-summary
integration, full-app denial/revocation or Windows Desktop behavior.

The same six-scenario synthetic facts in native-shaped Mac and Windows
envelopes also traversed main projection, ten-minute summaries, six-hour
rollups and reads. A deterministic extraction model retained all 17 selected
task facts in both mixed and separate windows; text-transfer denial retained
none. This is transport coverage, not model accuracy. Two real Astra calls
then summarized mixed evidence and its rollup, preserving failed/unrun work,
competing proposals and old/current distinctions without inventing a successful
release. Each retained 15 of 17 predefined facts in full, one in part, and
omitted one; all facts had reached the ten-minute input. This manual assessment
is not a general accuracy score. The rollup consumed one mixed-task child,
not a densely observed six-hour period. Natural-language outputs still require evidence-based evaluation;
valid JSON and sample IDs do not prove the truth of every claim.

Six additional deterministic replay cases used 135 unique archived native
records, including Mac selection/drag/editor/browser and Windows
WinForms/input/browser evidence. The current source pipeline projected those
original records, generated ten-minute and six-hour Markdown with a
deterministic provider, and read them through the real Skill tool schemas.
All 20 predefined Mac facts and 19 Windows facts survived permitted text
replay; transmission-denied cases retained no content facts. Raw pagination
reconstructed the complete permitted projection, including duplicates.
Native clipping remained explicit and unrecoverable. These replays use
archived synthetic native evidence, not fresh capture, a real summary model
or the later Windows numeric-selection and UIA-action changes.
The unchanged six-case harness was rerun after the rollup guard removal,
epoch-157 correction and shared selected-item projection. All cases passed
again, with the eight shared source files unchanged during execution and no
real provider calls. These archives contain no selected-item events; the
separate projection/service regressions cover that field. Replay validates
current shared transport, not newer native capture behavior.

The existing settings components also passed 12 matched before/after captures
and 56 checks at 1280px and 430px. Packaged recent choices, exact exclusion
save/readback/removal and standard executable IDs worked without overflow or
asset errors. The labelled icons and metadata are synthetic; native icon
acceptance remains separate. Screenshot provenance is in
`.github/assets/computer-history/README.md`.

Earlier source identity, callback attribution, delta persistence, early-prefix
sampling, stale-window regeneration and bounded detail-lookup defects have
dedicated repairs and regressions. They are not current known defects merely
because older reports listed them. Samples remain incomplete observations;
captured actions do not prove their intended outcomes.

Remaining parity gates include current Codex matched runtime comparison,
complete packaged capture-to-conversation use, ordinary-user Windows, real OS lock/disconnect,
wider browser/provider coverage and live storage-failure recovery. The Windows
lab account had High integrity with UAC disabled. Private-window heuristics do
not establish universal privacy coverage. Missing or ambiguous source
provenance still rejects content rather than increasing compatibility by
weakening admission. There is no complete parity or production-readiness claim.

There are also concrete capability gaps rather than just missing tests:
Windows native-child actions cover supported Edit/RichEdit controls. The newer
observed WPF/Chrome keyboard path still needs actual recorder acceptance;
WinUI input, typed characters/IME and cross-control drags remain unsupported.
Numeric selection without text reads currently covers standard Edit, not
every UIA provider. Closed-app icon
discovery uses exact App Paths or packaged AUMID registrations, not an
inventory of all installed applications. Automatic analysis uses bounded lexical
prior-summary selection; the approved conversation Skill already supports
model-directed Search, Read and ReadEvents within the retained history corpus.
A current-source synthetic case with one project anchor omitted an earlier retry
decision that became eligible with a second independent error anchor. The saved
decision remained searchable. This is a conservative automatic-selection limit,
not lost transport or evidence that another planning model would improve recall.
Observed filenames do not authorize opening arbitrary current files, whose
contents may differ from the recording.

Saved suggestions enter rollup/prior evidence, but duplicate suppression remains
a model instruction rather than a semantic guarantee. Broader automatic
retrieval must preserve recorded-text consent, exclusion checks, bounded
evidence, provider-call accounting and immutable deletion ancestry. A summary
cannot reconstruct a fact omitted by native capture or lost after raw expiry.
