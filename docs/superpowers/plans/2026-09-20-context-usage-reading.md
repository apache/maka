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

# Context Usage Reading Implementation Plan

**Goal:** Carry one explicit unavailable/measured/stale reading from the desktop resolver to both Composer hosts.

**Architecture:** A UI-owned presentation type keeps tokens and their metered window together. The existing pure desktop resolver accepts LiveContextUsage directly; subscriptions and runtime ordering remain unchanged.

**Tech Stack:** TypeScript, React, Node test runner.

## Constraints

Preserve working-tree changes, current input/output counting, window precedence, localization and existing compaction-time policy. Do not introduce runtime checkpoint versioning or a new subscription layer.

## Tasks

- [x] Add `ContextUsageReading` in `packages/ui/src/context-usage-reading.ts` and export it. Cases: `unavailable`, `measured` with `tokens` and optional `meteredWindow`, and `stale` with reason `compaction`.
- [x] Change `resolveContextUsage` to accept the existing `LiveContextUsage` shape and return that union. Test stale, missing/equal timestamps, post-fold recovery and paired metered windows in `latest-request-usage.test.ts`.
- [x] Pass `reading` directly from ChatComposerRegion and WorkHubRoot to Composer. Replace repeated inline live types with `LiveContextUsage`. Migrate the existing Storybook fixture.
- [x] Change Composer rendering to discriminate `reading.kind`. Update component tests for unavailable, stale, recovery, window precedence and opening the trace.
- [x] Update `live-context-usage.test.ts` to verify timestamp propagation, including different completion times across refreshes.
- [x] Build UI and desktop test targets; run the focused tests, renderer and story type checks, and inspect the final diff. Record unrelated blockers if present.

## Validation

- UI build and desktop renderer type check passed.
- 36 focused tests passed: latest request selection/resolution, live usage mapping/tracking, and Composer rendering.
- Renderer architecture check and `git diff --check` passed.
- Full desktop main and Storybook type checks are blocked by unchanged Git review base-branch option mismatches in `git-review-main.ts:163` and `session-workbar.stories.tsx:255`. These are outside this change.
