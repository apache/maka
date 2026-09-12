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

# Shared UI Storybook

Read [the shared fidelity convention](../../../apps/desktop/stories/FIDELITY.md)
before adding or changing stories. Use its rules rather than maintaining a
second version here.

- Prefer `../src/__tests__` for pure state and component behavior that the
  existing Node/React harness can verify. Do not create a browser story solely
  because a test happens to render React.
- Keep real Chromium layout, scrolling, selection, focus and animation checks
  in the browser tier. Fake DOM geometry is not layout evidence; viewport,
  theme or wheel requirements alone do not justify Electron. Follow
  [Electron admission](../../../apps/desktop/e2e/AGENTS.md) before escalating.
- Exercise the shared component through its production props and behavior.
  Desktop-specific shell wiring belongs in the Desktop stories; do not copy
  that shell into a UI fixture. Preserve the real owning frame for geometry.
- Reuse existing scenarios and imports, and prove migrated regression
  assertions can detect the defect before deleting their old coverage.

These stories run in the Desktop Storybook host. Follow the
[Desktop validation instructions](../../../apps/desktop/stories/AGENTS.md)
for typecheck, build and smoke; there is no separate UI Storybook runner.
