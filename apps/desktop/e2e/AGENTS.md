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

# Electron test admission

Before adding or extending a test here, choose the lowest tier that can expose
the actual defect. Apply this to each behavioral assertion, not just each file.
Existing tests and entries in `../e2e-budget.json` are not exemptions. See #4761,
#4877 and #4892 for the migration history.

1. Use existing unit, component or integration tests for state, event ordering,
   request routing, storage and recovery. Desktop renderer tests already run
   from `../src/main/__tests__` through `node --test`; React tests use the existing
   fake DOM. The directory name does not restrict them to main-process code.
   Shared UI tests live in `../../../packages/ui/src/__tests__`.
2. Use Storybook or a focused browser test when the assertion needs Chromium:
   layout, scrolling, selection, focus, animation, viewport or theme behavior.
   Reuse `../stories`, `../../../packages/ui/stories` and
   [the fidelity convention](../stories/FIDELITY.md).
3. Use Electron only when a lower tier would miss a concrete Electron boundary:
   native window/input behavior, Electron preload/main integration, or a
   cross-process persistence or lifecycle failure requiring the actual app.

## Prove the boundary

- State beside each test which Electron-owned mechanism it verifies and what
  defect a lower-tier test would miss. A call used only to prepare the scenario
  is not that mechanism. Creating a Host Session does not make a focus test an
  IPC test; reading a Host snapshot does not by itself prove Electron is needed.
- Real wheel input, CDP, geometry, localStorage, page reload, or a preload test
  latch alone do not establish an Electron requirement. Trace the owner of the
  behavior being asserted. Node integration tests can also exercise real Host
  and storage boundaries.
- Do not justify a renderer-only assertion by another test in the same file,
  an already-open window, or an unchanged test count. Keep Electron journeys
  focused on their necessary boundaries; move independent renderer contracts.
- Search existing lower-tier coverage before adding a replacement. Extend the
  actual component/controller/service seam; do not copy product logic into a
  second shell or introduce a global render-completion protocol for tests.

## Migrate and verify

- Establish that the replacement detects the original defect, preferably by
  reverting the relevant behavior or a targeted mutation. Verify the behavioral
  failure, not merely an import/type error or the absence of a new helper.
- Delete replaced E2E cases, duplicate assertions and unreferenced fixture hooks
  in the same PR. Preserve any independent native or cross-process protection.
- Do not raise timeouts, add retries, or weaken assertions to make a migration
  pass. Diagnose a red replacement before deciding it is a harness problem.
- Update `../e2e-budget.json` with counts and concrete boundary reasons, then run
  `npm run check:e2e-budget` from the repository root. This checks inventory
  consistency; a green result is not proof of correct tier selection.
- Build before running compiled tests or Storybook smoke. Run Electron tests
  from `apps/desktop` because the fixtures use that working directory. Report
  transferred/lost protection and fixture launches or traversals removed,
  separately from the number of test declarations.
