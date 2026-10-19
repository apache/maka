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

# Desktop Storybook

Before adding or changing stories, read [FIDELITY.md](FIDELITY.md), the shared
convention for both Desktop and UI stories.

- Prefer existing unit/component tests for state, event ordering, request
  routing and persistence. Desktop renderer tests can live in
  `../src/main/__tests__` using the existing Node/React test seam.
- Use this browser tier for real layout, scrolling, selection, focus and
  animation that a fake DOM cannot verify. Another viewport or theme is not a
  reason to move the test to Electron; apply [Electron admission](../e2e/AGENTS.md)
  before escalating.
- Reuse the production component, controller and frame. Extend an existing
  story when it already reaches the behavior; do not duplicate product logic or
  build a second shell to make the test easy.
- Check the smoke runner's actual viewport/theme jobs. Storybook toolbar
  settings alone do not establish automated coverage. Follow FIDELITY for
  reachable states, framing and assertion timing.
- For migrated regression coverage, demonstrate that the assertion detects the
  original defect, then remove the replaced E2E assertions and unused fixtures
  in the same PR. Do not compensate for failures with longer timeouts, retries
  or a global render-completion protocol.

The Desktop Storybook host also discovers `packages/ui/stories`. From the
repository root, run `npm --workspace @maka/desktop run typecheck:stories` and
`npm --workspace @maka/desktop run build-storybook` before
`npm --workspace @maka/desktop run smoke:storybook`. Smoke does not rebuild the
catalog. For focused runs, verify that the relevant `play` functions finish;
an image of the final screen alone does not prove their assertions passed.

## Pixel evidence for layout refactors

Smoke proves a story renders; it never compares pixels. Refactors that promise
no visual change (the A1 work under #5793) attach before/after evidence with
`scripts/storybook-visual-diff.mjs`, which shoots the chat-surface story set
with a frozen clock and disabled animations:

```sh
npm --workspace @maka/desktop run build-storybook
npm run shots:storybook -- capture --out /tmp/maka-shots/before
# apply the refactor, rebuild storybook
npm run shots:storybook -- capture --out /tmp/maka-shots/after
npm run shots:storybook -- compare /tmp/maka-shots/before /tmp/maka-shots/after
```

`compare` lists identical stories and writes a magenta-on-dim diff image per
changed shot under `<after>-diff/`. Attach the diff image (or the zero-diff
output) to the PR. Keep both captures on the same machine — the font stack
starts with `-apple-system`, so a cross-OS comparison diffs every glyph. Use
`--stories <substring>` to focus on the stories a change touches. Captures are
local artifacts: never commit them, and nothing here runs in CI.
