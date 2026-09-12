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

# Review Branch References Implementation Plan

**Goal:** Compare against the selected branch even when a tag has the same name.

**Architecture:** Carry `{ label, value }` branch options through the Git review snapshot. Use full refs for Git commands and persisted selection, and short labels for display. Resolve legacy names only against enumerated branches; reject ambiguous names so the panel's existing fallback clears them.

**Tech Stack:** TypeScript, React, Git, node:test.

## Steps

- [x] Update `packages/core/src/git-review.ts` with a branch option type. Update `apps/desktop/src/main/git-review-main.ts` to enumerate full refs, resolve defaults using full refs, and normalize legacy selections against option labels.
- [x] Update the review picker/model and Storybook fixture to use option values and persist canonical backend selections.
- [x] Extend `git-review-main.test.ts` with same-name branch/tag, local/remote label collision, legacy migration, and rejected tag cases. Update picker/model tests to check canonical values and short labels.
- [x] Build core and desktop main; run the two focused node:test suites, renderer/Storybook type checks, and changed-file formatting checks. Inspect the final diff.

## Validation

Core and desktop main builds passed. Renderer and Storybook type checks passed. Both focused suites passed (14 tests). Changed-file lint, configured formatting, renderer architecture, and git diff whitespace checks passed.
