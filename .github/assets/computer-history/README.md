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
