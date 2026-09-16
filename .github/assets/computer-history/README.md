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

# Computer History UI Evidence

## Windows Application Identity

Captured September 16, 2026 using the actual `ComputerHistorySettingsPage`,
application hooks, exclusion normalizer, icon component and production styles.
Before substitutes only the three application-ID validators from
`c73755700805efddce0411f2fdd92f7994e327b6`; after uses the current validators.
The remaining components and shared core source are identical in both builds.

Pairs use 1280 x 900 and 430 x 900, English, light mode, DPR 1, 100% zoom, a
fixed displayed event time and the same exclusion-heading scroll anchor.
`before-*` and `after-*` files cover `recent`, `manual-add`, and
`seeded-exclusions` for both `desktop` and `narrow`.

The exact packaged Notepad ID is absent from recent choices before the repair
and present afterward. Manual entry changes from a validation error to an exact
saved exclusion. The seeded pair starts with the same two exclusions and
demonstrates resolved packaged metadata while preserving the standard Edit ID.
The narrow ID wraps without hiding its Remove control.

Playwright verified all 12 captures and 56 behavior/asset checks, including
exact add/readback/removal, preserved standard exclusions, decoded PNGs, no
horizontal overflow, no page/asset errors and no external requests.
Names and 48px PNG icons are synthetic and explicitly labelled in each image.
These test real renderer behavior, not native icon lookup, full settings-modal
navigation or Windows recording. Existing platform-specific copy is unchanged.
The screenshots contain no private history or real settings writes.

The installed CLI has no native attachment option. These unchanged PNGs use
this PR's existing feature-branch asset directory, not a separate image branch.

## Approved Conversation Retrieval

The `retrieval-permission-*.png` screenshots were captured September 15, 2026
using the actual `ClientCapabilityPrompt`, production CSS and synthetic requests.
Both sides use English, light mode, DPR 1, 100% zoom, height 720, the same
`computer_history` request and capability scope. Widths are 1280 and 320.

Before freezes the component and copy from
`63281490612318511ea264d493b744d556c14cbb`. That version cannot render the new
capability, so its labeled harness error boundary displays the actual error.
This is a compatibility diagnostic, not a historical production error screen.
After uses the working revision adding authorized retrieval; pending captures
follow an actual Allow click with the response promise held unresolved.
Reject receives initial focus; both buttons disable during submission.

Playwright verified no horizontal overflow or clipped text, expected before
errors, Allow dispatch and disabled pending controls. All six PNGs were inspected.
No private history, model-request bodies, credentials or live desktop content
are present. The installed GitHub CLI lacks native attachment support, so these
files follow this PR's existing feature-branch asset convention.

## Metadata And Search Follow-Up

Captured on September 14, 2026 from the production Computer History page and
reader with synthetic services. The baseline source is revision
`839113807cd9776ff10f7640752f7106094cc3dc`. Both sides use the same invented
activities and Markdown, selected 08:30 entry, Preview mode, scroll position 0,
zh-CN, Asia/Shanghai, DPR 1, 100% zoom, and a fixed 08:40 clock.

| Image | Viewport | State |
| --- | --- | --- |
| `metadata-before-1240-light-reader.png` | 1240 x 820 | Previous reader, same selected entry |
| `metadata-after-1240-light-reader.png` | 1240 x 820 | Keywords below the description |
| `metadata-before-390-dark-reader.png` | 390 x 844 | Previous narrow reader |
| `metadata-after-390-dark-reader.png` | 390 x 844 | Wrapping keywords in the narrow reader |
| `metadata-after-1240-light-body-search-6h.png` | 1240 x 820 | Complete-body matches in six-hour view |
| `metadata-after-1240-light-filename.png` | 1240 x 820 | Main-owned readable filename |
| `metadata-after-390-dark-day.png` | 390 x 844 | Keywords within a day collection |

The long keyword intentionally exercises wrapping. The day view is a collection
of existing documents, not a separately generated daily summary. Application
icons use the existing synthetic fixtures. These are isolated page captures,
not full mobile-shell support or evidence of real application-icon lookup.

The final browser matrix passed 16 before and 48 after captures with no page
errors, broken images, unexpected external requests or overflowing tracked
regions. It covers all three granularities, filename and body matches beyond
the 12,000-character context preview, keyboard keyword activation, search focus,
legacy entries, invalid queries and source/copy behavior. Query responses are
bounded excerpts; idle polling does not include full document search text.

These PNGs are copied without retouching. No actual history, private screenshot,
credential or live provider result is included. The installed GitHub CLI has
no native image attachment option; this uses the existing feature-branch asset
convention.

Captured on September 13, 2026 from actual production components in
`apps/desktop/stories/computer-history.stories.tsx`, with synthetic service
responses. No private history, user avatar, real Electron session, recorder,
permission request, or model invocation was used.

| Image | Viewport | State |
| --- | --- | --- |
| `before-history-reader-1440.png` | 1440 x 900 | Previous production hierarchy, first activity selected, real sidebar |
| `after-history-reader-1440.png` | 1440 x 900 | Same selected activity and sidebar after separating history/settings |
| `after-history-feed-1440.png` | 1440 x 900 | New default full-width feed, no automatic selection |
| `after-history-settings-1440.png` | 1440 x 900 | Dedicated history settings inside the production settings surface |
| `after-history-settings-390.png` | 390 x 844 | Responsive settings surface |
| `after-history-reader-dark-390.png` | 390 x 844 | Dark reader with task list and syntax-highlighted TypeScript |

## Comparison Conditions

The before/after reader pair uses the same six invented activities, selected
first activity, paused recording, text/model consent off, light theme,
`zh-CN` locale, `Asia/Shanghai` timezone, DPR 1, 100% zoom, and fixed clock
`2026-09-13T12:30:00+08:00`. Both use the actual `SessionSidebarNav`.
The baseline was captured at 15:15-15:16 and the after images at 16:08.
The selected document starts at the top in both paired images.

The same title, description, headings, list, and table are visible in the
paired screenshots. Below the captured fold, the follow-up list became a
Markdown task list for additional testing. The dark narrow image is
supplemental syntax/responsiveness evidence, not an exact before/after pair.

The narrow reader uses the isolated production history page; it does not
claim mobile support for the desktop global sidebar. Settings use the actual
`SettingsModal` and `ComputerHistorySettingsPage`, not a drawn replica.

## Asset Provenance

The before image is copied unchanged from the locally archived pre-split
production screenshot. After images are copied unchanged from the static
Storybook QA run. There is no compositing, retouching, or generated UI.
Application icons visible within screenshots came from local synthetic
application metadata fixtures. The original branded PNG fixtures remain
ignored and are not bundled with the renderer or included in this directory;
application names and marks belong to their respective owners.

The installed GitHub CLI has no native attachment option. These six images
are kept on the feature branch for PR links, with user authorization. No
separate image branch or GitHub Contents API upload is used.

## Document Toolbar Follow-Up

The following images capture the actual production history reader before and
after the approved "Activity summary" toolbar and Reveal in Finder changes.
They are not screenshots of the naming alternatives.

| Image | Viewport | State |
| --- | --- | --- |
| `document-toolbar-before.png` | 1440 x 900 | Original filename toolbar, first summary selected |
| `document-toolbar-after.png` | 1440 x 900 | Matched summary with approved toolbar |
| `document-toolbar-after-light-390.png` | 390 x 844 | Responsive light reader |
| `document-toolbar-info-dark-390.png` | 390 x 844 | Dark reader with settled original-filename popover |

This follow-up uses the local `separated.html` synthetic-service preview:
1440 x 900, light theme, DPR 1, 100% zoom, `zh-CN`, `Asia/Shanghai`, fixed clock
`2026-09-13T12:30:00+08:00`, first activity selected, reader scroll position 0.
The stored fixture filename is `10min-1789273200000.md`. The history and
document are production components; the surrounding preview sidebar is
prototype scaffolding, not the production `SessionSidebarNav`.
The before/after desktop pair has identical title, body, selection, theme,
viewport and scroll position. Its document body is the separated-preview
fixture; it does not form a matched pair with the earlier reader screenshots
above. The supplemental images use the same fixture. Screenshot capture waits
for finite DOM animations to finish and stable geometry over consecutive
frames; the narrow info popover is fully opaque and 320px wide.

The final synthetic browser matrix passed 12 records: eight preview/source
geometry checks and four interaction cases across both widths and themes.
It verifies exact original-filename and full-Markdown clipboard text,
keyboard focus restoration, reveal success/error callbacks and pending guards,
and source/scroll preservation. There were no page errors, downloads, action
network requests or settings writes. The previous clipboard text was restored.
Finder callbacks are synthetic here; these images do not establish native
Finder behavior. No private history or real recorder was accessed.

## Summary-Only Feed Follow-Up

| Image | Viewport | State |
| --- | --- | --- |
| `summary-feed-before.png` | 1240 x 820 | Six summaries mixed with two newer raw fragments |
| `summary-feed-after.png` | 1240 x 820 | Same fixture, six summaries and a generation notice |
| `summary-reader-after.png` | 1240 x 820 | First summary selected with metadata and normalized headings |
| `summary-waiting-narrow.png` | 390 x 844 | Raw records exist; first summary has not started |
| `summary-failed-narrow.png` | 390 x 844 | First summary failed; explicit retry remains available |
| `summary-reader-dark-narrow.png` | 390 x 844 | Scrolled preview with table, task list and highlighted code |

The feed pair uses the `MixedPending` story with identical synthetic data,
paused recording, running analysis, light theme, `zh-CN`, Asia/Shanghai,
100% zoom, and no selected activity. It includes the real production sidebar.
The before image was captured in Chrome; the after image was captured in the
Codex in-app browser. A Chrome extension overlay is visible only in the
baseline. Sidebar relative ages follow wall-clock time rather than a frozen
clock. Images are unedited; these environment differences are not app changes.

Narrow screenshots use the isolated production history surface. Resizing the
global-sidebar fixture to 390px exposed its fixed-width rail taking most of
the viewport, including when its navigation was collapsed. This existing
fixture does not establish mobile support for the full Desktop shell; the
isolated reader and empty states have no page-level horizontal overflow.
The actual desktop trial was checked separately at 1240 x 820, without
publishing private activity screenshots or generated documents.

## Independent Text Consent

| Image | Viewport | State |
| --- | --- | --- |
| `text-consent-before.png` | 1240 x 820 | Existing three controls |
| `text-consent-after.png` | 1240 x 820 | Independent recorded-text transmission control |
| `text-consent-after-narrow.png` | 390 x 844 | Scrolled content/analysis section |
| `text-consent-after-dark.png` | 1240 x 820 | Dark settings surface |

Captured from production `SettingsModal` and `ComputerHistorySettingsPage`,
using synthetic services: recording enabled, local text capture off, summaries
on, recorded-text transmission off, model `coproxy::gpt-6-astra`, `zh-CN`,
Asia/Shanghai, DPR 1 and 100% zoom. The matched desktop pair has identical
viewport, initial state, content and scroll position. The narrow image is
supplemental, scrolled to expose all analysis controls. The before component
is frozen from the pre-consent implementation, not a redrawn mockup.

The production browser matrix passed 29 records with no failures. It covers
exact independent patches, no writes on mount, controlled pending state,
provider/model-required admission, failed-write recovery, disabled-model
revocation, light/dark themes and narrow geometry. Synthetic services did
not collect activity, contact a model, or read private history. Files are
copied unchanged from the ignored production QA captures; no retouching or
compositing was applied. The GitHub CLI still lacks native attachments, so
these images reuse the existing feature-branch asset convention.

## Dependent Summary Deletion Warning

Captured on September 14, 2026 (Asia/Shanghai). This copy-only follow-up
discloses deletion of dependent later summaries and possible deletion of
later legacy documents whose dependencies are unknown.

| Image | Viewport | State |
| --- | --- | --- |
| `deletion-scope-before.png` | 1240 x 820 | Previous deletion warning |
| `deletion-scope-after.png` | 1240 x 820 | Dependency-aware deletion warning |
| `deletion-scope-before-narrow.png` | 390 x 844 | Previous warning, narrow |
| `deletion-scope-after-narrow.png` | 390 x 844 | Dependency-aware warning, narrow |

Both pairs use the existing `separated.html` synthetic-service preview,
the same six invented activities, first activity selected, reader scroll
position 0, paused recording, text/model consent off, light theme, `zh-CN`,
Asia/Shanghai, DPR 1, 100% zoom, and fixed clock
`2026-09-13T12:30:00+08:00`. The history page and deletion dialog are actual
production components. The surrounding sidebar and preview header are
prototype scaffolding, not the production Desktop shell.

Before and after are isolated Vite production bundles served by the existing
local QA preview. The baseline freezes the worktree immediately before this
copy follow-up, based on HEAD `09d48337ddbdf3490c30f5999e8183c1fbdd346b`;
it is not an unmodified HEAD build. Only the three locale
`removeDescription` values differ between the frozen copy sources.

All four captures passed settled-dialog geometry, complete visible copy and
buttons, no page overflow, loaded images, cancel-without-deletion, focus
restoration, and synthetic confirmation checks. All three locale copy checks
passed; the page-state, settings and controller source-bundled tests passed
36/36. The source story also passed an isolated bundle build; its Storybook
play functions were not rerun for this copy-only follow-up.

Screenshots were written directly by local Playwright and visually inspected.
No private history, real Electron session, native recorder, permissions,
clipboard, or model service was accessed. Only local GET requests were
allowed, with no unexpected requests or page errors. The preview's in-memory
deletion removes one fixture row; this UI check does not claim to validate
backend dependency invalidation. No compositing, retouching or post-capture
blurring was applied; the background blur is the production dialog backdrop.
These assets retain the existing authorized feature-branch convention.

## Inline Summary Model Selection

Captured on September 14, 2026 (Asia/Shanghai). The user selected alternative A:
an inline searchable selector and a separate Manage connections action.

| Images | Viewport | State |
| --- | --- | --- |
| `model-{before,after}-1240-{light,dark}.png` | 1240 x 820 | Matched analysis section, scrollTop 282 |
| `model-{before,after}-390-{light,dark}.png` | 390 x 844 | Matched analysis section, scrollTop 482 |
| `model-after-1240-light-selector.png` | 1240 x 820 | Open model selector |
| `model-after-390-dark-selector.png` | 390 x 844 | Open model selector, narrow/dark |
| `model-manage-local-1240-light.png` | 1240 x 820 | Models destination with contextual return |
| `model-manage-local-390-light.png` | 390 x 844 | Models destination with wrapped Host selector |

Both revisions render production `SettingsModal`, `ComputerHistorySettingsPage`,
and Desktop adapters against the same in-memory synthetic bridge. The baseline
freezes changed source files from `ef78153f396252648bfb9046b2f59f694dd4f539`.
The fixture selects a remote settings profile while History resolves the local
Host, exposes invented Coproxy Astra/Luna entries, and enables all four consent
switches. Paired images use identical content, viewport, scroll position,
`zh-CN`, Asia/Shanghai, DPR 1, 100% zoom, and fixed clock
`2026-09-14T00:30:00Z`.

The final browser matrix passed 18 groups: matched light/dark desktop/narrow
rendering, search/dismiss without writes, exact model-only saves, canonical
default, missing/unavailable models, catalog retry, local Host failure without
remote fallback, three locales, contextual return with scroll/focus restoration,
and deferred save success/failure across remount. There were no unexpected
browser errors or external requests. All 39 local QA screenshots were checked
for geometry; the selected public images were visually inspected.

The ignored rerunnable harness is
`docs/local/computer-history-production-qa/verify-model-production.mjs`.
No native capture, model request, credentials, or private history were used for
these images. They are copied unchanged from Playwright output. The GitHub CLI
does not expose a native attachment option; these files reuse this PR's existing
feature-branch asset convention.

## History Granularity

Captured on September 14, 2026 (Asia/Shanghai). The user selected alternative A:
a persistent segmented selector below the page heading.

| Images | Viewport | State |
| --- | --- | --- |
| `granularity-{before,after}-1240-light-reader.png` | 1240 x 820 | Matched saved-document reader |
| `granularity-{before,after}-390-light-reader.png` | 390 x 844 | Matched narrow reader |
| `granularity-after-1240-light-list.png` | 1240 x 820 | Six-hour overview and pending interval |
| `granularity-after-1240-light-day.png` | 1240 x 820 | Complete saved documents for one day |
| `granularity-after-390-dark-day.png` | 390 x 844 | Narrow dark day reader |
| `granularity-after-1240-light-cross-midnight.png` | 1240 x 820 | Today filter with a cross-midnight rollup |
| `granularity-after-1240-light-source.png` | 1240 x 820 | Source retained across granularity changes |

Both revisions render the actual production history page against the same
synthetic service, six invented ten-minute activities and one six-hour summary.
The baseline page, copy and CSS are frozen from
`5b3f30ce4c32dc350104573c60a67b48a6ed24ec`; its feed projection suppresses
covered children as the baseline backend did. Both reader pairs select the
08:30 activity, Preview mode, scrollTop 0, `zh-CN`, Asia/Shanghai, DPR 1,
100% zoom and fixed clock `2026-09-14T00:40:00Z`. Capture order and fixture
content are identical. These isolated page captures do not claim full mobile
Desktop shell support.

The final Playwright matrix passed 30 captures with no page errors, external
requests, missing images or page/reader overflow. It covers all three views,
independent disclosure and document opening, cross-midnight date filtering,
Source and scroll retention, a new saved document arriving on a background
poll, light/dark themes and three locales. The day view assembles existing
documents; it does not request or create another model-generated daily report.

The ignored rerunnable harness is
`docs/local/computer-history-production-qa/verify-granularity-production.mjs`.
Public captures were visually inspected and copied unchanged from Playwright
output. No private history, native capture, real model request or credentials
were used for these images. Real Electron checks are separate and remain
private. The installed GitHub CLI lacks native attachments; these images
reuse this feature branch's existing asset convention.

## Conversation Draft Markdown

Captured on September 14, 2026 (Asia/Shanghai). This fixes a data projection
that flattened summary Markdown before it reached the existing review dialog.

| Image | Viewport | State |
| --- | --- | --- |
| `skill-draft-before.png` | 1240 x 820 | Selected synthetic summary, previous single-line draft body |
| `skill-draft-after.png` | 1240 x 820 | Same summary and dialog, preserved Markdown line breaks |

Both images render the unchanged production `ComputerHistoryPage` and draft
review dialog. The harness executes the exact AST-extracted `summaryEntry`
and `observedText` functions from `d0b2ac23` and the updated source against the
same invented summary. Only `contextMarkdown` varies between captures.
Other renderer data, selection, light theme, `zh-CN`, Asia/Shanghai, DPR 1,
100% zoom, fixed clock `2026-09-14T01:00:00Z`, and zero dialog/textbox scroll
are identical. The dialog geometry matches, with no page overflow.

The paired text values contain six and sixteen lines respectively. The
synthetic harness verifies heading and code-fence boundaries, exact draft
handoff, and cancel-without-handoff. The review field remains an editable
Markdown source textbox; the reader behind it uses rendered Markdown.

Ignored capture sources and verification are under
`docs/local/computer-history-production-qa/skill-live/synthetic-draft*`.
The PNGs are direct Playwright captures without retouching or compositing.
No private history, real model request, credentials, native capture or
permission changes were used. Separate real-conversation checks remain
private. These images reuse the existing authorized feature-branch convention.

## Unified History Permissions

Captured on September 14, 2026 (Asia/Shanghai), after the user selected
alternative B: History settings shows an aggregate permission state and a
link; OS grant actions and rechecks live in the existing Permission Center.
The public selection contains five matched pairs and two contextual views.

| Before | After | Viewport and state |
| --- | --- | --- |
| [History](permission-before-history-zh-CN-1240-light.png) | [History](permission-after-history-zh-CN-1240-light.png) | 1240 x 820, zh-CN, light |
| [Permission Center](permission-before-center-zh-CN-1240-light.png) | [Permission Center](permission-after-center-zh-CN-1240-light.png) | 1240 x 820, zh-CN, light, All scope |
| [History](permission-before-history-zh-CN-390-light.png) | [History](permission-after-history-zh-CN-390-light.png) | 390 x 844, zh-CN, light |
| [Permission Center](permission-before-center-zh-CN-390-light.png) | [Permission Center](permission-after-center-zh-CN-390-light.png) | 390 x 844, zh-CN, light, All scope |
| [Permission Center](permission-before-center-en-390-dark.png) | [Permission Center](permission-after-center-en-390-dark.png) | 390 x 844, English, dark, All scope |

The [desktop History context](permission-after-history-context-zh-CN-1240-light.png)
and [narrow History context](permission-after-history-context-zh-CN-390-light.png)
are reached through History's actual permission link. They show the contextual
return control, focused missing Input Monitoring row, two required permissions,
and a separate section for the other three permissions. They are supplemental
interaction evidence, not before/after pairs.

Both revisions mount production `SettingsModal`, History settings,
Permission Center, Desktop adapters and shared UI providers against the same
synthetic bridge. Matched conditions are DPR 1, 100% zoom, Asia/Shanghai,
fixed clock `2026-09-14T00:30:00Z`, recording enabled, Accessibility granted,
Input Monitoring missing, Screen Recording denied, and notification/automation
state unknown. Text capture and both summary consent switches remain off.
QA Remote, QA Provider and qa-model are invented fixture values.

The baseline source was frozen at `2026-09-14T02:34:43.229Z`. Its Permission
Center component and copy were verified byte-for-byte against `d0b2ac23`;
the remaining dependencies are identified by snapshot time, not attributed to
that revision. The old center has four IDs and no consumer projection; the
after fixture adds the canonical Input Monitoring ID with `canRequest: false`
and explicit recorder-consumer states. This preserves the same underlying
permission conditions while representing each revision's protocol.

The final after build was captured from source at
`2026-09-14T03:08:43.704Z`. It uses the extracted permissions feature through
the compatible settings entry, puts all grant buttons below descriptions,
and separates local OS permissions from the selected Host's capabilities.
Currentness checks found no changes in 463 consumed production files or 625
Storybook source files after their respective runs.

Validation passed 20/20 production interaction tests and 40 after captures,
plus all 83 actual settings stories / 85 theme renders with their `play`
functions and AX checks. Coverage includes three locales, both viewports and
themes, contextual return focus/scroll, five canonical rows, four unchanged
consent switches, no navigation writes, grant readback, action/read failures,
helper/Electron disagreement, and local permissions with absent/offline Hosts.
Narrow permission descriptions measured 230px against a 150px minimum.
No unexpected browser errors, missing assets or external requests occurred.

All 24 before and 40 after images remain in the ignored
`docs/local/computer-history-production-qa/permission-production/matrix/`.
Rerunnable harnesses, reports and full provenance use the
`permission-production*` prefix in that QA directory. These 12 public PNGs
are unchanged Playwright output, visually inspected and byte-matched to the
matrix. No private history, credentials, real model calls, native capture or
OS permission changes were used. Synthetic checks do not establish real
macOS TCC authorization; live Desktop validation is separate.
