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

# Desktop smoke runbook

Use the narrowest deterministic check that covers the change, then add live-window evidence or a Storybook story when the risk requires it. Scenario inventories and check identifiers live in the scripts and fixtures, not in this document.

## Automated desktop checks

Run the desktop test suite for main-process, IPC, fixture, or contract changes:

```bash
npm --workspace @maka/desktop test
```

For a journey across renderer and main, extend the existing Playwright E2E suite and run:

```bash
npm --workspace @maka/desktop run e2e
```

Keep these runs on the fake backend and use deterministic fixtures.

## Real Electron window smoke

Screenshots and DOM checks do not prove native resize, drag regions, modal focus, or a healthy live renderer. Changes to the shell, sidebar, modal backdrop, window drag regions, or top-level renderer lifecycle must run:

```bash
npm --workspace @maka/desktop run smoke:real-window
```

The script builds the required workspaces, launches Electron with isolated user data, records programmatic checks, and prompts for native OS checks. Confirm that:

- the window launches without a crash or ErrorBoundary;
- each edge resizes and dragging all four corners resizes diagonally;
- allowed titlebar regions drag the window while controls do not;
- the Search modal opens and closes by button, backdrop, and Escape;
- Tab and Shift+Tab stay inside the modal and return focus afterward;
- modal-open window edges remain resizable;
- switching modules after closing the modal leaves the renderer healthy.

Reports are written under `apps/desktop/tests/real-window-smoke/`. A failed or unverified native check must remain visible in the report. A UI-shell PR is not ready to merge until the required report is attached or summarized for review.

For environments that cannot perform native hit testing, run the programmatic layer explicitly and record the limitation:

```bash
npm --workspace @maka/desktop run smoke:programmatic-window
```

## Storybook baseline and visual contracts

Storybook is the production-backed design catalog, not a screenshot or desktop E2E harness. Page-level stories (e.g. `apps/desktop/stories/settings/settings-pages.stories.tsx`) render each surface with mocked IPC via `withScopedMakaBridge`; add a story variant for any state the page does not already cover. CI only builds the catalog and mounts every story once without running `play`. Style, layout and interaction invariants belong in focused component contracts or the real Electron E2E harness. Run Storybook with:

```bash
npm --workspace @maka/desktop run storybook
```

To inspect a deterministic fixture interactively without touching a real workspace (the same `MAKA_E2E_FIXTURE` mechanism the Playwright E2E suite uses):

```bash
MAKA_E2E_FIXTURE=all npm --workspace @maka/desktop run dev
```

Use a scenario name from the fixture registry for a narrower launch.

## Release floor

Before a release, run the full automated suite and real-window smoke on supported desktop platforms. Visual regressions are caught by Storybook stories and computed-style contract tests; record any platform that could not be verified rather than treating absence of evidence as a pass.
