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
