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

# WorkHub prompt-suggestion UI evidence

2026-09-23. Rebased on upstream main `c7d205a42`.

## Reachable surface and interaction

`Product/WorkHub/NextPromptSuggestion` (`product-workhub--next-prompt-suggestion`) mounts the production WorkHubRoot, controller and shared Composer. Only service transport and predicted text are fixtures. Its play function sends a request, observes the completed reply, compares exact glyph rectangles and typography before/after Tab, verifies that Tab does not send, sends the accepted draft with Enter, dismisses the next suggestion with Esc, then leaves a new suggestion visible.

The actual smoke catalog explicitly schedules this story at 1280×900 and 720×900 in light and dark themes. The focused real Chromium run used the production smoke probe and completed all four plays with zero recorded failures; see [results.json](results.json). The entire Storybook catalog was not run.

The independent mutation check injects only the former 12px suggestion padding. The play assertion fails on glyph geometry, captured as `playFunctionThrewException`; see [alignment-mutation.json](alignment-mutation.json). This also revealed a missing event listener in the general smoke probe, which now records play exceptions as failures.

## Screenshots

Captured from the built Storybook in the Codex in-app browser after its play reached the final suggestion state. Ego Chromium performed the four assertion runs; its screenshot calls timed out, so images came from the in-app browser instead. Images are not represented as Ego captures.

![1280px light](workhub-light-wide.png)

![720px dark](workhub-dark-narrow.png)

## Host and native integration

The updated [WorkHub native check](../prompt-suggestion-smoke/workhub-check.json) now returns a generated suggestion and verifies Tab without send, native Undo, Enter reaching the durable coordination transcript, Esc, and delayed-result draft preservation. It uses real WorkHub WebContentsView → preload → main → Runtime Host → controlled local HTTP prediction endpoint. Conversation replies use the existing FakeBackend. This validates wiring and interaction, not paid-model suggestion quality.

Only the permanent WorkHub coordination identity is newly eligible. Background child sessions, plan/side sessions, non-AI-SDK sessions, pending interactions, active goals, running/queued work and incognito remain excluded. WorkHub predictions use recent visible conversation and do not revive the original task from the permanent session's distant past. Hidden question/form composers invalidate suggestions.

## Checks

- Full workspace build; Storybook typecheck and production build; renderer typecheck and architecture: passed.
- Focused coordinator/UI tests: 13 passed. Smoke-runner unit tests: 15 passed.
- Execution/model composition suite: 37 passed on standalone rerun. The existing implementation-child-patch test timed out once during a combined run, then passed alone and in the complete standalone suite.
- Protocol tests in the combined run passed; ASF headers and whitespace checks passed.

Build and open the story:

```sh
npm --workspace @maka/desktop run typecheck:stories
npm --workspace @maka/desktop run build-storybook
python3 -m http.server 6011 --bind 127.0.0.1 --directory apps/desktop/storybook-static
# /iframe.html?id=product-workhub--next-prompt-suggestion&viewMode=story&globals=colorScheme:light;palette:default
```
